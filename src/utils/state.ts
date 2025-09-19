/**
 * State handling utilities for payment session management.
 */
import { Logger } from "../types/logger.js";
import { StateStoreProvider } from "../core/state-store.js";
import { BasePaymentProvider } from "../providers/base.js";
import { normalizeStatus } from "./payment.js";

interface CheckPaymentResult {
    paymentId?: string;
    paymentUrl?: string;
    storedArgs?: any;
    shouldExecuteImmediately: boolean;
}

/**
 * Check for existing payment state and handle recovery.
 */
export async function checkExistingPayment(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    provider: BasePaymentProvider,
    toolName: string,
    toolArgs: any,
    log?: Logger
): Promise<CheckPaymentResult> {
    if (!sessionId || !stateStore) {
        return { shouldExecuteImmediately: false };
    }

    log?.debug?.(`Checking state store for sessionId=${sessionId}`);
    const state = await stateStore.get(sessionId);

    if (!state) {
        return { shouldExecuteImmediately: false };
    }

    log?.info?.(`Found existing payment state for sessionId=${sessionId}`);
    const paymentId = state.payment_id;
    const paymentUrl = state.payment_url;
    const storedArgs = state.tool_args;
    const storedToolName = state.tool_name;

    // Check payment status with provider
    try {
        const status = normalizeStatus(await provider.getPaymentStatus(paymentId));
        log?.info?.(`Payment status for ${paymentId}: ${status}`);

        if (status === "paid") {
            // Payment already completed!
            log?.info?.(`Previous payment detected, executing with original request`);
            // Clean up state
            await stateStore.delete(sessionId);

            // Return stored args if they were for this function
            if (storedToolName === toolName) {
                return {
                    paymentId,
                    paymentUrl,
                    storedArgs,
                    shouldExecuteImmediately: true
                };
            } else {
                // Different function, use current args
                return {
                    paymentId,
                    paymentUrl,
                    storedArgs: undefined,
                    shouldExecuteImmediately: true
                };
            }
        } else if (status === "pending") {
            // Payment still pending, use existing payment
            log?.info?.(`Payment still pending, continuing with existing payment`);
            return {
                paymentId,
                paymentUrl,
                shouldExecuteImmediately: false
            };
        } else if (status === "canceled") {
            // Payment failed, clean up and create new one
            log?.info?.(`Previous payment canceled, creating new payment`);
            await stateStore.delete(sessionId);
            return { shouldExecuteImmediately: false };
        }
    } catch (err) {
        log?.error?.(`Error checking payment status: ${err}`);
        // If we can't check status, clean up and create new payment
        await stateStore.delete(sessionId);
        return { shouldExecuteImmediately: false };
    }

    return {
        paymentId,
        paymentUrl,
        shouldExecuteImmediately: false
    };
}

/**
 * Save payment state for recovery.
 */
export async function savePaymentState(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    paymentId: string,
    paymentUrl: string,
    toolName: string,
    toolArgs: any,
    status: string = 'requested',
    log?: Logger
): Promise<void> {
    if (!sessionId || !stateStore) {
        return;
    }

    log?.info?.(`Storing payment state for sessionId=${sessionId}`);
    await stateStore.put(sessionId, {
        session_id: sessionId,
        payment_id: paymentId,
        payment_url: paymentUrl,
        tool_name: toolName,
        tool_args: toolArgs,
        status,
        created_at: Date.now()
    });
}

/**
 * Update the status of an existing payment state.
 */
export async function updatePaymentStatus(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    status: string,
    log?: Logger
): Promise<void> {
    if (!sessionId || !stateStore) {
        return;
    }

    const state = await stateStore.get(sessionId);
    if (state) {
        state.status = status;
        await stateStore.put(sessionId, state);
        log?.debug?.(`Updated payment status to ${status} for sessionId=${sessionId}`);
    }
}

/**
 * Clean up payment state after completion or cancellation.
 */
export async function cleanupPaymentState(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    log?: Logger
): Promise<void> {
    if (sessionId && stateStore) {
        await stateStore.delete(sessionId);
        log?.debug?.(`Cleaned up payment state for sessionId=${sessionId}`);
    }
}