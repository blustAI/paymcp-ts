// Progress payment flow: keep the tool call open, periodically poll the payment
// provider, and stream progress updates back to the client until payment
// completes (or is canceled / times out). 

import { paymentPromptMessage } from "../utils/messages.js";
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import { Logger } from "../types/logger.js";
import { ToolExtraLike } from "../types/config.js";
import { normalizeStatus } from "../utils/payment.js";
import type { StateStoreProvider } from "../core/state-store.js";


export const DEFAULT_POLL_MS = 3_000; // poll provider every 3s
export const MAX_WAIT_MS = 15 * 60 * 1000; // give up after 15 minutes

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


async function safeReportProgress(
    extra: ToolExtraLike,
    log: Logger,
    message: string,
    progressPct: number,
    totalPct = 100
): Promise<void> {


    // --- Token-based fallback -------------------------------------------------
    // FastMCP Python (and some other clients) expose a progress token in the
    // extra metadata but *not* a callable report_progress. In that case we must
    // emit a protocol-compliant notification ourselves:
    //   method: 'notifications/progress'
    //   params: { progressToken, progress, total, message }
    // If we instead send a made-up method (like 'progress/update') the client
    // will raise Pydantic validation errors (you saw those).
    const sendNote = (extra as any)?.sendNotification;
    const token =
        (extra as any)?._meta?.progressToken ?? (extra as any)?.progressToken;
    if (typeof sendNote === "function" && token !== undefined) {
        try {
            await sendNote({
                method: "notifications/progress",
                params: {
                    progressToken: token,
                    progress: progressPct,
                    total: totalPct,
                    message,
                },
            });
            return;
        } catch (err) {
            log?.warn?.(
                `[PayMCP:Progress] progress-token notify failed: ${(err as Error).message}`
            );
            // fall through to simple log below
        }
    }

    // No usable progress channel; just log so we don't spam invalid notifications.

    log?.debug?.(
        `[PayMCP:Progress] progress ${progressPct}/${totalPct}: ${message}`
    );
}


export const makePaidWrapper: PaidWrapperFactory = (
    func,
    _server,
    provider,
    priceInfo,
    toolName,
    logger,
    stateStore
) => {
    const log: Logger = logger ?? (provider as any).logger ?? console;

    async function wrapper(paramsOrExtra: any, maybeExtra?: ToolExtraLike) {
        log?.debug?.(
            `[PayMCP:Progress] wrapper invoked for tool=${toolName} argsLen=${arguments.length}`
        );

        // Normalize (args, extra) vs (extra) call shapes (SDK calls tool cb this way).
        const hasArgs = arguments.length === 2;
        const toolArgs = hasArgs ? paramsOrExtra : undefined;
        const extra: ToolExtraLike = hasArgs
            ? (maybeExtra as ToolExtraLike)
            : (paramsOrExtra as ToolExtraLike);

        // Extract session ID from extra context
        const sessionId = extra?.sessionId;

        // Check for existing payment state if we have a session ID and state store
        let paymentId: string | undefined;
        let paymentUrl: string | undefined;

        if (sessionId && stateStore) {
            log?.debug?.(`[PayMCP:Progress] Checking state store for sessionId=${sessionId}`);
            const state = await stateStore.get(sessionId);

            if (state) {
                log?.info?.(`[PayMCP:Progress] Found existing payment state for sessionId=${sessionId}`);
                paymentId = state.payment_id;
                paymentUrl = state.payment_url;
                const storedArgs = state.tool_args;
                const storedToolName = state.tool_name;

                // Check payment status with provider
                try {
                    const status = normalizeStatus(await provider.getPaymentStatus(paymentId));
                    log?.info?.(`[PayMCP:Progress] Payment status for ${paymentId}: ${status}`);

                    if (status === "paid") {
                        // Payment already completed! Execute tool with original arguments
                        log?.info?.(`[PayMCP:Progress] Previous payment detected, executing with original request`);

                        // Clean up state
                        await stateStore.delete(sessionId);

                        // Use stored arguments if they were for this function
                        if (storedToolName === toolName) {
                            // Use stored args instead of current ones
                            const result = await callOriginal(func, storedArgs?.params, extra);
                            return result;
                        } else {
                            // Different function, just execute normally
                            return await callOriginal(func, toolArgs, extra);
                        }
                    } else if (status === "pending") {
                        // Payment still pending, continue with existing payment
                        log?.info?.(`[PayMCP:Progress] Payment still pending, continuing with existing payment`);
                        // Continue to polling with existing payment
                    } else if (status === "canceled") {
                        // Payment failed, clean up and create new one
                        log?.info?.(`[PayMCP:Progress] Previous payment canceled, creating new payment`);
                        await stateStore.delete(sessionId);
                        paymentId = undefined;
                        paymentUrl = undefined;
                    }
                } catch (err) {
                    log?.error?.(`[PayMCP:Progress] Error checking payment status: ${err}`);
                    // If we can't check status, create a new payment
                    await stateStore.delete(sessionId);
                    paymentId = undefined;
                    paymentUrl = undefined;
                }
            }
        }

        // -----------------------------------------------------------------------
        // 1. Create payment session if needed
        // -----------------------------------------------------------------------
        if (!paymentId) {
            const payment = await provider.createPayment(
                priceInfo.amount,
                priceInfo.currency,
                `${toolName}() execution fee`
            );
            paymentId = payment.paymentId;
            paymentUrl = payment.paymentUrl;
            log?.debug?.(
                `[PayMCP:Progress] created payment id=${paymentId} url=${paymentUrl}`
            );

            // Store payment state if we have session ID and state store
            if (sessionId && stateStore) {
                log?.info?.(`[PayMCP:Progress] Storing payment state for sessionId=${sessionId}`);
                await stateStore.put(sessionId, {
                    session_id: sessionId,
                    payment_id: paymentId,
                    payment_url: paymentUrl,
                    tool_name: toolName,
                    tool_args: { params: toolArgs },  // Store args for replay
                    status: 'requested',
                    created_at: Date.now()
                });
            }
        }

        // -----------------------------------------------------------------------
        // 2. Initial progress message (0%) with payment link
        // -----------------------------------------------------------------------
        await safeReportProgress(
            extra,
            log,
            paymentPromptMessage(paymentUrl, priceInfo.amount, priceInfo.currency),
            0,
            100
        );

        // -----------------------------------------------------------------------
        // 3. Poll provider until paid / canceled / timeout
        // -----------------------------------------------------------------------
        const start = Date.now();
        let elapsed = 0;
        let status = "pending";

        while (elapsed < MAX_WAIT_MS) {
            // Allow client aborts (AbortSignal pattern)
            if ((extra as any)?.signal?.aborted) {
                log?.warn?.(
                    `[PayMCP:Progress] aborted by client while waiting for payment.`
                );
                return {
                    content: [{ type: "text", text: "Payment aborted by client." }],
                    annotations: { payment: { status: "canceled", payment_id: paymentId } },
                    status: "canceled",
                    message: "Payment aborted by client",
                    payment_id: paymentId,
                    payment_url: paymentUrl,
                };
            }

            await delay(DEFAULT_POLL_MS);
            elapsed = Date.now() - start;

            const raw = await provider.getPaymentStatus(paymentId);
            status = normalizeStatus(raw);
            log?.debug?.(
                `[PayMCP:Progress] poll status=${raw} -> ${status} elapsed=${elapsed}ms`
            );

            if (status === "paid") {
                await safeReportProgress(
                    extra,
                    log,
                    "Payment received — running tool…",
                    100,
                    100
                );
                break;
            }

            if (status === "canceled") {
                await safeReportProgress(
                    extra,
                    log,
                    `Payment ${raw} — aborting.`,
                    0,
                    100
                );
                // Clean up state on cancellation
                if (sessionId && stateStore) {
                    await stateStore.delete(sessionId);
                }
                return {
                    content: [{ type: "text", text: "Payment canceled." }],
                    annotations: { payment: { status: "canceled", payment_id: paymentId } },
                    status: "canceled",
                    message: "Payment canceled",
                    payment_id: paymentId,
                    payment_url: paymentUrl,
                };
            }

            // still pending — emit heartbeat (elapsed ratio up to 99%)
            const pct = Math.min(Math.floor((elapsed / MAX_WAIT_MS) * 99), 99);
            await safeReportProgress(
                extra,
                log,
                `Waiting for payment… (${Math.round(elapsed / 1000)}s elapsed):\n ${paymentUrl}`,
                pct,
                100
            );
        }

        if (status !== "paid") {
            // Timed out waiting for payment
            log?.warn?.(
                `[PayMCP:Progress] timeout waiting for payment paymentId=${paymentId}`
            );
            // Don't delete state on timeout - payment might still complete
            if (sessionId && stateStore) {
                const state = await stateStore.get(sessionId);
                if (state) {
                    state.status = 'timeout';
                    await stateStore.put(sessionId, state);
                }
            }
            return {
                content: [{ type: "text", text: "Payment timeout reached; aborting." }],
                annotations: {
                    payment: { status: "error", reason: "timeout", payment_id: paymentId },
                },
                status: "error",
                message: "Payment timeout reached; aborting",
                payment_id: paymentId,
                payment_url: paymentUrl,
            };
        }

        // -----------------------------------------------------------------------
        // 4. Payment succeeded -> invoke wrapped tool handler
        // -----------------------------------------------------------------------
        log.info?.(`[PayMCP:Progress] payment confirmed; invoking original tool ${toolName}`);

        // Update state to paid if we have state store
        if (sessionId && stateStore) {
            const state = await stateStore.get(sessionId);
            if (state) {
                state.status = 'paid';
                await stateStore.put(sessionId, state);
            }
        }

        const toolResult = await callOriginal(func, toolArgs, extra);

        // Clean up state after successful execution
        if (sessionId && stateStore) {
            await stateStore.delete(sessionId);
        }
        // Ensure toolResult has required MCP 'content' field; if not, synthesize text.
        if (!toolResult || !Array.isArray((toolResult as any).content)) {
            return {
                content: [{ type: "text", text: "Tool completed after payment." }],
                annotations: { payment: { status: "paid", payment_id: paymentId } },
                raw: toolResult,
            };
        }
        // augment annotation
        try {
            (toolResult as any).annotations = {
                ...(toolResult as any).annotations,
                payment: { status: "paid", payment_id: paymentId },
            };
        } catch { /* ignore */ }
        return toolResult;
    }

    return wrapper as unknown as ToolHandler;
};

// ---------------------------------------------------------------------------
// Helper: safely invoke the original tool handler preserving args shape
// ---------------------------------------------------------------------------
async function callOriginal(
    func: ToolHandler,
    args: any | undefined,
    extra: ToolExtraLike
) {
    if (args !== undefined) {
        return await func(args, extra);
    } else {
        return await func(extra);
    }
}