/**
 * Shared constants for PayMCP
 */

// Payment status constants
export const PaymentStatus = {
    PAID: 'paid',
    PENDING: 'pending',
    CANCELED: 'canceled',
    EXPIRED: 'expired',
    FAILED: 'failed',
    ERROR: 'error',
    TIMEOUT: 'timeout',
    REQUESTED: 'requested',
    UNSUPPORTED: 'unsupported'
} as const;

export type PaymentStatusType = typeof PaymentStatus[keyof typeof PaymentStatus];

// Timing constants
export const Timing = {
    DEFAULT_POLL_MS: 3_000,        // Poll every 3 seconds
    MAX_WAIT_MS: 15 * 60 * 1000,   // 15 minutes timeout
    STATE_TTL_MS: 30 * 60 * 1000,  // 30 minutes state TTL
} as const;

// MCP response types
export const ResponseType = {
    SUCCESS: 'success',
    ERROR: 'error',
    PENDING: 'pending',
    CANCELED: 'canceled',
} as const;

// Flow types
export const FlowType = {
    TWO_STEP: 'TWO_STEP',
    PROGRESS: 'PROGRESS',
    ELICITATION: 'ELICITATION',
} as const;

export type FlowTypeValue = typeof FlowType[keyof typeof FlowType];