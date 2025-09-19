/**
 * Shared constants for PayMCP TypeScript implementation.
 *
 * DESIGN DECISION: Separate from Python constants.py
 * - TypeScript uses milliseconds (Node.js standard), Python uses seconds
 * - Each implementation uses language-appropriate patterns (const objects vs classes)
 * - Values are synchronized manually between languages
 */

/**
 * Payment status constants used across all payment providers and flows.
 *
 * These constants standardize how payment states are represented throughout
 * the TypeScript system. All payment providers must return these exact string
 * values to ensure consistent handling across different flows and state management.
 *
 * Status Lifecycle:
 * 1. REQUESTED → PENDING → PAID (successful path)
 * 2. REQUESTED → PENDING → CANCELED (user cancellation)
 * 3. REQUESTED → PENDING → FAILED (provider error)
 * 4. REQUESTED → PENDING → EXPIRED (timeout)
 *
 * Each status has specific semantics:
 * - Terminal states: PAID, CANCELED, FAILED, EXPIRED (no further changes)
 * - Active states: REQUESTED, PENDING (can transition to terminal states)
 * - Error states: ERROR, TIMEOUT, UNSUPPORTED (system-level issues)
 *
 * Usage by components:
 * - Providers: Must return these exact values from getPaymentStatus()
 * - State management: Uses these for state transitions and cleanup decisions
 * - Flows: Check these values to determine next actions
 * - Response builders: Map these to appropriate user messages
 */
export const PaymentStatus = {
    /** Successful completion - payment verified and accepted */
    PAID: 'paid',

    /** Payment is being processed, final status not yet determined */
    PENDING: 'pending',

    /** User explicitly canceled the payment (not a system error) */
    CANCELED: 'canceled',

    /** Payment timeout - provider gave up waiting */
    EXPIRED: 'expired',

    /** Payment failed due to provider error (invalid card, insufficient funds, etc.) */
    FAILED: 'failed',

    /** System-level error (network issues, malformed requests, etc.) */
    ERROR: 'error',

    /** Client-side timeout (user disconnected while payment was processing) */
    TIMEOUT: 'timeout',

    /** Initial state when payment is first created */
    REQUESTED: 'requested',

    /** Payment method is not supported by the provider */
    UNSUPPORTED: 'unsupported'
} as const;

/** Type for payment status values with full TypeScript type safety */
export type PaymentStatusType = typeof PaymentStatus[keyof typeof PaymentStatus];

/**
 * Timing constants for payment flow behavior and performance tuning.
 *
 * These values control various timing aspects of payment flows and can be
 * adjusted based on performance requirements and user experience needs.
 *
 * Note: TypeScript uses milliseconds while Python uses seconds for consistency
 * with JavaScript/Node.js timing conventions.
 *
 * Considerations for timing values:
 * - Shorter polls = better responsiveness, more API calls
 * - Longer timeouts = better for slow payment methods, more resource usage
 * - Longer TTL = better recovery, more memory usage
 */
export const Timing = {
    /** How often to check payment status during active polling (3 seconds) */
    DEFAULT_POLL_MS: 3_000,

    /** Maximum time to wait for payment completion (15 minutes) */
    MAX_WAIT_MS: 15 * 60 * 1000,

    /** How long to keep payment state in storage for recovery (30 minutes) */
    STATE_TTL_MS: 30 * 60 * 1000,
} as const;

/**
 * MCP response type constants for consistent client communication.
 *
 * These constants define the standardized response statuses that MCP clients
 * expect to receive. They are used in response builders to ensure all
 * payment flows return properly formatted responses.
 *
 * These map to but are distinct from PaymentStatus constants:
 * - ResponseType: Client-facing status for MCP protocol
 * - PaymentStatus: Provider-specific payment state
 *
 * Mapping examples:
 * - PaymentStatus.PAID → ResponseType.SUCCESS
 * - PaymentStatus.PENDING → ResponseType.PENDING
 * - PaymentStatus.CANCELED → ResponseType.CANCELED
 * - PaymentStatus.FAILED → ResponseType.ERROR
 */
export const ResponseType = {
    /** Tool execution completed successfully after payment */
    SUCCESS: 'success',

    /** An error occurred during payment or tool execution */
    ERROR: 'error',

    /** Payment is required and in progress */
    PENDING: 'pending',

    /** Payment was canceled by user or system */
    CANCELED: 'canceled',
} as const;

/**
 * Payment flow types - separate implementations instead of unified flow.
 *
 * DESIGN DECISION: Why separate flows instead of one unified flow?
 * - Each flow optimized for specific client capabilities (elicitation, progress, basic)
 * - Avoids complex branching logic in unified implementation
 * - Easier testing and maintenance of individual flows
 */
const PaymentFlowValues = {
    /** Two-step flow: separate payment initiation and confirmation */
    TWO_STEP: 'two_step',

    /** Progress flow: single call with progress reporting */
    PROGRESS: 'progress',

    /** Elicitation flow: interactive prompts for payment */
    ELICITATION: 'elicitation',

    /** Out-of-band flow: payment handled externally */
    OOB: 'oob',
} as const;

/** Payment flow constants */
export const PaymentFlow = PaymentFlowValues;

/** Type for payment flow values with full TypeScript type safety */
export type PaymentFlow = typeof PaymentFlowValues[keyof typeof PaymentFlowValues];