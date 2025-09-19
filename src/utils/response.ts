/**
 * Response builder utilities for consistent MCP responses across TypeScript payment flows.
 *
 * This module standardizes how payment flows return data to MCP clients by providing
 * a unified interface for building response objects. It ensures all payment flows
 * return consistent, properly structured responses that work with different MCP clients.
 *
 * This TypeScript version mirrors the Python implementation in paymcp/utils/response.py
 * while adapting to TypeScript typing and MCP protocol specifics.
 *
 * Key Features:
 * 1. Response standardization: Consistent structure across all payment flows
 * 2. Type safety: Full TypeScript typing for response fields and status values
 * 3. Client compatibility: Responses work with various MCP client implementations
 * 4. Two-step flow support: Special handling for multi-step payment workflows
 * 5. MCP protocol: Proper content and annotation formatting
 *
 * Why this exists:
 * - Different payment flows (elicitation, progress, sync) need consistent responses
 * - MCP clients expect predictable response structures for proper display
 * - Tool results need to be wrapped appropriately for client consumption
 * - Payment metadata (IDs, URLs, amounts) must be included consistently
 */

import { PaymentStatus, ResponseType } from './constants.js';

/**
 * MCP content structure for text responses.
 * All responses must include content array for proper MCP protocol compliance.
 */
export interface McpContent {
    type: "text";
    text: string;
}

/**
 * Payment annotation structure for MCP protocol.
 * Annotations provide structured metadata about the payment state.
 */
export interface PaymentAnnotation {
    payment: {
        status: string;
        payment_id?: string;
        payment_url?: string;
        reason?: string;
        next_step?: string;
    };
}

/**
 * Complete MCP response structure with payment support.
 * Combines required MCP fields with payment-specific metadata.
 */
export interface McpResponse {
    /** Required MCP content array */
    content: McpContent[];

    /** Optional MCP annotations (used for payment metadata) */
    annotations?: PaymentAnnotation;

    /** Response status for client processing */
    status?: string;

    /** Human-readable message */
    message?: string;

    /** Payment identifier for tracking */
    payment_id?: string;

    /** Payment URL for user completion */
    payment_url?: string;

    /** Next tool to call (two-step flows) */
    next_step?: string;

    /** Structured data for programmatic access */
    structured_content?: any;

    /** Alternative field name for structured data */
    data?: any;

    /** Original tool result preservation */
    raw?: any;
}

/**
 * Build a standardized MCP response with consistent structure and fields.
 *
 * This is the core response builder used by all payment flows to ensure
 * consistent output format. It handles optional fields gracefully and
 * provides special formatting for two-step flows.
 *
 * Response Structure:
 * - Always includes: content array (MCP protocol requirement)
 * - Payment fields: payment_id, payment_url (when applicable)
 * - Flow control: next_step (for two-step flows)
 * - Error handling: reason (for error responses)
 * - Tool results: raw (original tool output)
 * - Metadata: amount, currency (for payment context)
 * - Annotations: payment metadata (MCP protocol standard)
 *
 * @param message - Human-readable message describing the response.
 *                  Example: "Payment completed successfully"
 * @param status - Response status from ResponseType constants.
 *                 Values: SUCCESS, PENDING, ERROR, CANCELED
 * @param options - Optional payment and tool metadata.
 *
 * @returns MCP-compliant response object with payment context.
 *
 * @example
 * ```typescript
 * const response = buildResponse(
 *     "Payment completed successfully",
 *     ResponseType.SUCCESS,
 *     {
 *         paymentId: "pay_abc123",
 *         rawResult: { result: "Generated image" }
 *     }
 * );
 * ```
 */
export function buildResponse(
    message: string,
    status: string = ResponseType.SUCCESS,
    options?: {
        paymentId?: string;
        paymentUrl?: string;
        nextStep?: string;
        reason?: string;
        rawResult?: any;
        amount?: number;
        currency?: string;
    }
): McpResponse {
    // Start with MCP-compliant base structure
    const response: McpResponse = {
        content: [{ type: "text", text: message }],
        status,
        message,
    };

    // Add MCP payment annotations when payment info is available
    // Annotations provide structured metadata for MCP protocol compliance
    if (options?.paymentId || options?.paymentUrl) {
        response.annotations = {
            payment: {
                status,
                ...(options.paymentId && { payment_id: options.paymentId }),
                ...(options.paymentUrl && { payment_url: options.paymentUrl }),
                ...(options.reason && { reason: options.reason }),
                ...(options.nextStep && { next_step: options.nextStep }),
            },
        };
    }

    // Add top-level fields for backward compatibility
    // Some clients may expect these fields at the response root
    if (options?.paymentId) response.payment_id = options.paymentId;
    if (options?.paymentUrl) response.payment_url = options.paymentUrl;
    if (options?.nextStep) response.next_step = options.nextStep;
    if (options?.rawResult) response.raw = options.rawResult;

    // Special handling for two-step flows
    // These require structured data for client processing
    if (options?.nextStep && options?.paymentUrl) {
        const structuredData = {
            payment_url: options.paymentUrl,
            payment_id: options.paymentId,
            next_step: options.nextStep,
            // Status mapping for client compatibility
            status: status === ResponseType.PENDING ? 'payment_required' : `payment_${status}`,
            ...(options.amount && { amount: options.amount }),
            ...(options.currency && { currency: options.currency }),
        };

        // Include both field names for client compatibility
        response.structured_content = structuredData;
        response.data = structuredData;
    }

    return response;
}

/**
 * Build a standardized error response for payment failures.
 *
 * This convenience function ensures all error responses have consistent
 * structure and include relevant context for debugging. It's used when
 * payment flows encounter recoverable or unrecoverable errors.
 *
 * @param message - User-friendly error message.
 * @param reason - Technical details for debugging.
 * @param paymentId - Payment ID if one was created before failure.
 * @param paymentUrl - Payment URL if one was generated.
 *
 * @returns Error response with ERROR status.
 *
 * @example
 * ```typescript
 * const errorResponse = buildErrorResponse(
 *     "Payment provider unavailable",
 *     "HTTP 503 Service Unavailable",
 *     "pay_failed_123"
 * );
 * ```
 */
export function buildErrorResponse(
    message: string,
    reason?: string,
    paymentId?: string,
    paymentUrl?: string
): McpResponse {
    return buildResponse(message, ResponseType.ERROR, {
        reason,
        paymentId,
        paymentUrl,
    });
}

/**
 * Build a standardized pending payment response.
 *
 * This response type indicates that a payment has been initiated but not
 * yet completed. It provides all necessary information for the user to
 * complete the payment and for the client to continue the flow.
 *
 * @param message - User instruction for completing payment.
 * @param paymentId - Unique identifier for tracking this payment.
 * @param paymentUrl - Where user goes to complete payment.
 * @param nextStep - Tool name for confirming payment (two-step flows).
 * @param amount - Payment amount for user reference.
 * @param currency - Currency code for amount display.
 *
 * @returns Pending response with PENDING status.
 *
 * @example
 * ```typescript
 * const pendingResponse = buildPendingResponse(
 *     "Complete payment to continue",
 *     "pay_123",
 *     "https://checkout.provider.com/pay_123",
 *     "confirm_payment_123",
 *     5.00,
 *     "USD"
 * );
 * ```
 */
export function buildPendingResponse(
    message: string,
    paymentId: string,
    paymentUrl: string,
    nextStep?: string,
    amount?: number,
    currency?: string
): McpResponse {
    return buildResponse(message, ResponseType.PENDING, {
        paymentId,
        paymentUrl,
        nextStep,
        amount,
        currency,
    });
}

/**
 * Build a standardized cancellation response for user-initiated cancellations.
 *
 * This response indicates that a payment was canceled by the user rather
 * than failing due to technical issues. It's important to distinguish
 * cancellations from failures for proper error handling and user experience.
 *
 * @param message - Cancellation message to display to user.
 * @param paymentId - Payment ID if one was created before cancellation.
 * @param paymentUrl - Payment URL if one was generated.
 *
 * @returns Cancellation response with CANCELED status.
 *
 * @example
 * ```typescript
 * const cancelResponse = buildCanceledResponse(
 *     "Payment canceled by user",
 *     "pay_canceled_123"
 * );
 * ```
 */
export function buildCanceledResponse(
    message: string = "Payment canceled",
    paymentId?: string,
    paymentUrl?: string
): McpResponse {
    return buildResponse(message, ResponseType.CANCELED, {
        paymentId,
        paymentUrl,
    });
}

/**
 * Build a standardized success response after tool execution.
 *
 * This function handles the final step of payment flows: wrapping the
 * actual tool result in a proper response format. It preserves the
 * original tool output while adding payment context.
 *
 * Tool Result Handling:
 * 1. If tool result has MCP content structure:
 *    - Preserve the existing structure
 *    - Add payment annotation if missing
 *    - Return enhanced result
 * 2. If tool result is raw data:
 *    - Wrap in standard response structure
 *    - Include raw data in "raw" field
 *    - Add success status and payment context
 *
 * @param toolResult - The actual result from executing the paid tool.
 * @param paymentId - Payment identifier for tracking.
 *
 * @returns Success response with tool result and payment context.
 *
 * @example
 * ```typescript
 * // Tool returns MCP-structured data
 * const mcpResult = {
 *     content: [{ type: "text", text: "Hello world" }]
 * };
 * const response = buildSuccessResponse(mcpResult, "pay_123");
 *
 * // Tool returns simple string
 * const simpleResult = "Generated image saved to file.png";
 * const response = buildSuccessResponse(simpleResult, "pay_456");
 * ```
 */
export function buildSuccessResponse(
    toolResult: any,
    paymentId?: string
): McpResponse {
    // Handle MCP-structured responses (already formatted)
    if (toolResult && Array.isArray(toolResult.content)) {
        // Tool already returned an MCP-compliant response
        // Add payment context while preserving existing structure
        if (paymentId) {
            try {
                // Add payment annotation without breaking existing structure
                toolResult.annotations = {
                    ...toolResult.annotations,
                    payment: { status: PaymentStatus.PAID, payment_id: paymentId },
                };
            } catch {
                // Ignore annotation errors, preserve original result
            }
        }
        return toolResult;
    }

    // Handle raw/unstructured responses
    // Wrap the raw result in our standard response format
    return buildResponse(
        "Tool completed after payment",
        ResponseType.SUCCESS,
        {
            paymentId,
            rawResult: toolResult,
        }
    );
}

/**
 * Format a message string specifically for two-step payment flows.
 *
 * Two-step flows require a JSON-formatted message that clients can parse
 * to extract payment URLs and confirmation tool names. This function
 * creates the standardized JSON format.
 *
 * @param message - Payment instruction message for the user.
 * @param paymentUrl - URL where user completes the payment.
 * @param paymentId - Unique payment identifier for tracking.
 * @param confirmToolName - Name of the tool to call after payment.
 *
 * @returns JSON string with two-step flow message structure.
 *
 * @example
 * ```typescript
 * const formattedMessage = formatTwoStepMessage(
 *     "Complete payment then call confirmation tool",
 *     "https://pay.example.com/checkout/123",
 *     "pay_123",
 *     "confirm_payment_123"
 * );
 * // Returns JSON string with message structure
 * ```
 */
export function formatTwoStepMessage(
    message: string,
    paymentUrl: string,
    paymentId: string,
    confirmToolName: string
): string {
    return JSON.stringify({
        message,
        payment_url: paymentUrl,
        payment_id: paymentId,
        next_step: confirmToolName,
    });
}