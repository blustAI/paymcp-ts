// Progress payment flow: keep the tool call open, periodically poll the payment
// provider, and stream progress updates back to the client until payment
// completes (or is canceled / times out). 

import { paymentPromptMessage } from "../utils/messages.js";
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import { Logger } from "../types/logger.js";
import { ToolExtraLike } from "../types/config.js";
import { normalizeStatus } from "../utils/payment.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { extractSessionId, logContextInfo } from "../utils/context.js";
import {
    checkExistingPayment,
    savePaymentState,
    updatePaymentStatus,
    cleanupPaymentState
} from "../utils/state.js";


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

        // Optional: log context info for debugging
        logContextInfo(extra, log);

        // Extract session ID from extra context using utility function
        const sessionId = extractSessionId(extra, log);

        // Check for existing payment state using utility
        const checkResult = await checkExistingPayment(
            sessionId, stateStore, provider, toolName, { params: toolArgs }, log
        );

        // If payment was already completed, execute immediately
        if (checkResult.shouldExecuteImmediately) {
            await safeReportProgress(
                extra,
                log,
                "Previous payment detected — running tool…",
                100,
                100
            );
            const argsToUse = checkResult.storedArgs?.params || toolArgs;
            return await callOriginal(func, argsToUse, extra);
        }

        // Use existing payment if available
        let paymentId = checkResult.paymentId;
        let paymentUrl = checkResult.paymentUrl;

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

            // Store payment state using utility
            await savePaymentState(
                sessionId, stateStore, paymentId, paymentUrl,
                toolName, { params: toolArgs }, 'requested', log
            );
        }

        // -----------------------------------------------------------------------
        // 2. Initial progress message (0%) with payment link
        // -----------------------------------------------------------------------
        await safeReportProgress(
            extra,
            log,
            paymentPromptMessage(paymentUrl!, priceInfo.amount, priceInfo.currency),
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
                await cleanupPaymentState(sessionId, stateStore, log);
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
            await updatePaymentStatus(sessionId, stateStore, 'timeout', log);
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

        // Update state to paid
        await updatePaymentStatus(sessionId, stateStore, 'paid', log);

        const toolResult = await callOriginal(func, toolArgs, extra);

        // Clean up state after successful execution
        await cleanupPaymentState(sessionId, stateStore, log);
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