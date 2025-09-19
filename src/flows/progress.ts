// Progress payment flow: keep the tool call open, periodically poll the payment
// provider, and stream progress updates back to the client until payment
// completes (or is canceled / times out).

import { paymentPromptMessage } from "../utils/messages.js";
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import { Logger } from "../types/logger.js";
import { normalizeStatus } from "../utils/payment.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { extractSessionId, logContextInfo } from "../utils/context.js";
import {
    checkExistingPayment,
    savePaymentState,
    updatePaymentStatus,
    cleanupPaymentState
} from "../utils/state.js";
import {
    callOriginalTool,
    normalizeToolArgs,
    delay,
    isClientAborted,
    logFlow
} from "../utils/flow.js";
import {
    buildCanceledResponse,
    buildErrorResponse,
    buildSuccessResponse
} from "../utils/response.js";
import { PaymentStatus, Timing } from "../utils/constants.js";

async function safeReportProgress(
    extra: any,
    log: Logger,
    message: string,
    progressPct: number,
    totalPct = 100
): Promise<void> {
    // Token-based fallback for FastMCP Python and other clients
    const sendNote = extra?.sendNotification;
    const token = extra?._meta?.progressToken ?? extra?.progressToken;

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
            logFlow(log, 'Progress', 'warn',
                `progress-token notify failed: ${(err as Error).message}`);
        }
    }

    // No usable progress channel; just log
    logFlow(log, 'Progress', 'debug',
        `progress ${progressPct}/${totalPct}: ${message}`);
}

export const makePaidWrapper: PaidWrapperFactory = (options) => {
    const { func, provider, priceInfo, toolName, logger, stateStore } = options;
    const log: Logger = logger ?? (provider as any).logger ?? console;

    async function wrapper(paramsOrExtra: any, maybeExtra?: any) {
        const { toolArgs, extra } = normalizeToolArgs(paramsOrExtra, maybeExtra);

        logFlow(log, 'Progress', 'debug',
            `wrapper invoked for tool=${toolName}`);

        // Optional: log context info for debugging
        logContextInfo(extra, log);

        // Extract session ID from extra context
        const sessionId = extractSessionId(extra, log);

        // Check for existing payment state
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
            return await callOriginalTool(func, argsToUse, extra);
        }

        // Use existing payment if available
        let paymentId = checkResult.paymentId;
        let paymentUrl = checkResult.paymentUrl;

        // Create payment session if needed
        if (!paymentId) {
            const payment = await provider.createPayment(
                priceInfo.amount,
                priceInfo.currency,
                `${toolName}() execution fee`
            );
            paymentId = payment.paymentId;
            paymentUrl = payment.paymentUrl;

            logFlow(log, 'Progress', 'debug',
                `created payment id=${paymentId} url=${paymentUrl}`);

            // Store payment state
            await savePaymentState(
                sessionId, stateStore, paymentId, paymentUrl,
                toolName, { params: toolArgs }, PaymentStatus.REQUESTED, log
            );
        }

        // Initial progress message with payment link
        await safeReportProgress(
            extra,
            log,
            paymentPromptMessage(paymentUrl!, priceInfo.amount, priceInfo.currency),
            0,
            100
        );

        // Poll provider until paid / canceled / timeout
        const start = Date.now();
        let elapsed = 0;
        let status: string = PaymentStatus.PENDING;

        while (elapsed < Timing.MAX_WAIT_MS) {
            // Allow client aborts
            if (isClientAborted(extra)) {
                logFlow(log, 'Progress', 'warn',
                    'aborted by client while waiting for payment');
                return buildCanceledResponse(
                    "Payment aborted by client",
                    paymentId,
                    paymentUrl
                );
            }

            await delay(Timing.DEFAULT_POLL_MS);
            elapsed = Date.now() - start;

            const raw = await provider.getPaymentStatus(paymentId);
            status = normalizeStatus(raw);

            logFlow(log, 'Progress', 'debug',
                `poll status=${raw} -> ${status} elapsed=${elapsed}ms`);

            if (status === PaymentStatus.PAID) {
                await safeReportProgress(
                    extra,
                    log,
                    "Payment received — running tool…",
                    100,
                    100
                );
                break;
            }

            if (status === PaymentStatus.CANCELED) {
                await safeReportProgress(
                    extra,
                    log,
                    `Payment ${raw} — aborting.`,
                    0,
                    100
                );
                // Clean up state on cancellation
                await cleanupPaymentState(sessionId, stateStore, log);
                return buildCanceledResponse(
                    "Payment canceled",
                    paymentId,
                    paymentUrl
                );
            }

            // Still pending — emit heartbeat
            const pct = Math.min(Math.floor((elapsed / Timing.MAX_WAIT_MS) * 99), 99);
            await safeReportProgress(
                extra,
                log,
                `Waiting for payment… (${Math.round(elapsed / 1000)}s elapsed):\n ${paymentUrl}`,
                pct,
                100
            );
        }

        if (status !== PaymentStatus.PAID) {
            // Timed out waiting for payment
            logFlow(log, 'Progress', 'warn',
                `timeout waiting for payment paymentId=${paymentId}`);
            // Don't delete state on timeout - payment might still complete
            await updatePaymentStatus(sessionId, stateStore, PaymentStatus.TIMEOUT, log);
            return buildErrorResponse(
                "Payment timeout reached; aborting",
                "timeout",
                paymentId,
                paymentUrl
            );
        }

        // Payment succeeded -> invoke wrapped tool handler
        logFlow(log, 'Progress', 'info',
            `payment confirmed; invoking original tool ${toolName}`);

        // Update state to paid
        await updatePaymentStatus(sessionId, stateStore, PaymentStatus.PAID, log);

        const toolResult = await callOriginalTool(func, toolArgs, extra);

        // Clean up state after successful execution
        await cleanupPaymentState(sessionId, stateStore, log);

        return buildSuccessResponse(toolResult, paymentId);
    }

    return wrapper as unknown as ToolHandler;
};