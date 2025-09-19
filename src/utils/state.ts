/**
 * State management utilities for TypeScript payment session persistence and recovery.
 *
 * This module provides critical functionality for handling payment state across
 * timeouts, disconnections, and reconnections. It implements the core logic for
 * client timeout recovery by persisting payment state in a StateStore.
 *
 * This TypeScript version mirrors the Python implementation in paymcp/utils/state.py
 * while adapting to TypeScript async patterns and the MCP TypeScript SDK.
 *
 * Key Features:
 * 1. Idempotency: Prevents duplicate payments for the same session
 * 2. Recovery: Resumes payments after client timeout/disconnect
 * 3. Cleanup: Manages state lifecycle to prevent memory leaks
 * 4. Status tracking: Monitors payment progression through various states
 *
 * The utilities work with any StateStoreProvider (InMemory, Redis, etc.)
 * to provide persistent payment state management.
 */
import { Logger } from "../types/logger.js";
import { StateStoreProvider } from "../core/state-store.js";
import { BasePaymentProvider } from "../providers/base.js";
import { normalizeStatus } from "./payment.js";

/**
 * Result structure for payment state checks.
 * Contains all information needed to continue or resume payment flows.
 */
interface CheckPaymentResult {
    /** Existing payment ID if found */
    paymentId?: string;

    /** Existing payment URL if found */
    paymentUrl?: string;

    /** Original tool arguments from when payment was created */
    storedArgs?: any;

    /** Whether tool should execute immediately (payment already completed) */
    shouldExecuteImmediately: boolean;
}

/**
 * Check for existing payment state and intelligently handle recovery scenarios.
 *
 * This is the core function for preventing duplicate payments. It:
 * 1. Looks up any existing payment for the current session
 * 2. Checks the actual payment status with the provider
 * 3. Decides whether to reuse, execute, or create new payment
 *
 * Recovery Scenarios Handled:
 * - Client timeout: Payment completed after client disconnected
 * - Duplicate request: Same tool called again in same session
 * - Failed payment: Previous payment failed, need new one
 * - Pending payment: Payment still processing, wait for completion
 *
 * @param sessionId - Current session ID from MCP context.
 *                    undefined means no session support.
 * @param stateStore - StateStore instance (InMemory, Redis, etc.).
 *                     undefined means state persistence disabled.
 * @param provider - Payment provider instance with getPaymentStatus method.
 * @param toolName - Name of the tool being executed (for verification).
 * @param toolArgs - Current arguments passed to the tool.
 * @param log - Optional logger for debugging.
 *
 * @returns Promise resolving to CheckPaymentResult with next actions.
 *
 * @example
 * ```typescript
 * const result = await checkExistingPayment(
 *     "session_123", store, provider, "generate", { prompt: "test" }, logger
 * );
 * if (result.shouldExecuteImmediately) {
 *     // Payment already done, execute tool immediately
 *     return await toolFunction(result.storedArgs || toolArgs);
 * }
 * ```
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
        // No session support or state store - cannot recover
        return { shouldExecuteImmediately: false };
    }

    // Step 1: Retrieve existing state from store
    log?.debug?.(`Checking state store for sessionId=${sessionId}`);
    const state = await stateStore.get(sessionId);

    if (!state) {
        // No existing payment for this session
        return { shouldExecuteImmediately: false };
    }

    // Step 2: Extract payment information from stored state
    log?.info?.(`Found existing payment state for sessionId=${sessionId}`);
    const paymentId = state.payment_id;
    const paymentUrl = state.payment_url;
    const storedArgs = state.tool_args;
    const storedToolName = state.tool_name;

    // Step 3: Verify actual payment status with provider (source of truth)
    // This handles cases where payment completed after client disconnected
    try {
        const rawStatus = await provider.getPaymentStatus(paymentId!);
        const status = normalizeStatus(rawStatus);
        log?.info?.(`Payment status for ${paymentId}: ${status}`);

        // Scenario 1: Payment already completed (e.g., after timeout)
        if (status === "paid") {
            log?.info?.(`Previous payment detected, executing with original request`);
            // Clean up state since payment is done
            await stateStore.delete(sessionId);

            // Use appropriate arguments based on tool match
            if (storedToolName === toolName) {
                // Same tool: use original args to maintain consistency
                return {
                    paymentId,
                    paymentUrl,
                    storedArgs,
                    shouldExecuteImmediately: true
                };
            } else {
                // Different tool: payment covers session, use current args
                return {
                    paymentId,
                    paymentUrl,
                    storedArgs: undefined,
                    shouldExecuteImmediately: true
                };
            }
        }
        // Scenario 2: Payment still in progress
        else if (status === "pending") {
            log?.info?.(`Payment still pending, continuing with existing payment`);
            // Reuse existing payment, don't create duplicate
            return {
                paymentId,
                paymentUrl,
                shouldExecuteImmediately: false
            };
        }
        // Scenario 3: Payment failed or was canceled
        else if (status === "canceled") {
            log?.info?.(`Previous payment canceled, creating new payment`);
            // Clean up failed payment state
            await stateStore.delete(sessionId);
            // Signal to create new payment
            return { shouldExecuteImmediately: false };
        }
    } catch (err) {
        // Provider communication failure
        log?.error?.(`Error checking payment status: ${err}`);
        // Conservative approach: clean up and create new payment
        // This prevents stuck states but might create duplicate payments
        await stateStore.delete(sessionId);
        return { shouldExecuteImmediately: false };
    }

    // Default case: return existing payment info without immediate execution
    return {
        paymentId,
        paymentUrl,
        shouldExecuteImmediately: false
    };
}

/**
 * Persist payment state for recovery after timeout or disconnection.
 *
 * This function saves all necessary information to resume a payment flow
 * after the client reconnects. The state is keyed by session_id to ensure
 * each session has at most one active payment.
 *
 * State Contents:
 * - Payment details: ID, URL for completion
 * - Tool information: Name and arguments for execution
 * - Metadata: Status, timestamps for debugging
 *
 * The saved state enables:
 * 1. Resuming payment after client timeout
 * 2. Preventing duplicate payments
 * 3. Executing the correct tool with original args
 * 4. Debugging payment issues
 *
 * @param sessionId - Current session ID from MCP context.
 *                    If undefined, state won't be saved (no recovery).
 * @param stateStore - StateStore instance (InMemory, Redis, etc.).
 *                     If undefined, state won't be saved.
 * @param paymentId - Unique payment ID from provider.
 * @param paymentUrl - URL where user completes payment.
 * @param toolName - Name of the tool being paid for.
 * @param toolArgs - Original arguments to pass to tool after payment.
 * @param status - Current payment status (default: 'requested').
 * @param log - Optional logger for debugging.
 *
 * @example
 * ```typescript
 * await savePaymentState(
 *     "session_123", store, "pay_abc", "https://pay.me",
 *     "generate", { prompt: "test" }, "requested", logger
 * );
 * ```
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
        // No session support or state store - cannot persist
        return;
    }

    log?.info?.(`Storing payment state for sessionId=${sessionId}`);

    // Create comprehensive state object
    const stateData = {
        session_id: sessionId,      // For cross-reference
        payment_id: paymentId,      // Provider's payment identifier
        payment_url: paymentUrl,    // Where user completes payment
        tool_name: toolName,        // Tool to execute after payment
        tool_args: toolArgs,        // Original args to preserve
        status,                     // Current payment status
        created_at: Date.now()      // Timestamp for TTL/debugging
    };

    // Store with automatic TTL based on StateStore configuration
    // InMemoryStore: Default TTL
    // RedisStore: Configurable TTL
    await stateStore.put(sessionId, stateData);
}

/**
 * Update the status of an existing payment state without losing other data.
 *
 * This function is used to track payment progression through various states:
 * - requested: Initial state when payment created
 * - pending: Payment URL opened, awaiting completion
 * - paid: Payment successfully completed
 * - timeout: Client disconnected while waiting
 * - canceled: User explicitly canceled
 * - failed: Payment failed for any reason
 *
 * Status updates are important for:
 * 1. Debugging payment issues
 * 2. Analytics and monitoring
 * 3. Deciding recovery strategy
 *
 * @param sessionId - Current session ID from MCP context.
 * @param stateStore - StateStore instance.
 * @param status - New payment status to set.
 * @param log - Optional logger for debugging.
 *
 * @example
 * ```typescript
 * await updatePaymentStatus("session_123", store, "paid", logger);
 * ```
 */
export async function updatePaymentStatus(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    status: string,
    log?: Logger
): Promise<void> {
    if (!sessionId || !stateStore) {
        // No session support or state store - cannot update
        return;
    }

    // Retrieve existing state
    const state = await stateStore.get(sessionId);
    if (state) {
        // Update only the status field, preserve other data
        state.status = status;
        // Optional: Add status change timestamp for debugging
        state[`status_${status}_at`] = Date.now();
        // Write back to store
        await stateStore.put(sessionId, state);
        log?.debug?.(`Updated payment status to ${status} for sessionId=${sessionId}`);
    } else {
        log?.warn?.(`No state found to update for sessionId=${sessionId}`);
    }
}

/**
 * Remove payment state after completion, cancellation, or failure.
 *
 * Cleanup is critical for:
 * 1. Preventing memory leaks in long-running services
 * 2. Removing sensitive payment information
 * 3. Allowing new payments for the session
 * 4. Maintaining clean state store
 *
 * This should be called:
 * - After successful payment and tool execution
 * - After payment cancellation
 * - After payment failure (non-recoverable)
 * - NOT after timeout (payment might still complete)
 *
 * @param sessionId - Current session ID from MCP context.
 * @param stateStore - StateStore instance.
 * @param log - Optional logger for debugging.
 *
 * @example
 * ```typescript
 * // After successful execution
 * const result = await toolFunction(args);
 * await cleanupPaymentState(sessionId, store, logger);
 * return result;
 * ```
 */
export async function cleanupPaymentState(
    sessionId: string | undefined,
    stateStore: StateStoreProvider | undefined,
    log?: Logger
): Promise<void> {
    if (sessionId && stateStore) {
        // Delete state from store
        // If using Redis, removes key immediately
        // If using InMemory, removes from map
        await stateStore.delete(sessionId);
        log?.debug?.(`Cleaned up payment state for sessionId=${sessionId}`);
    }
}