/**
 * Response builder utilities for consistent MCP responses
 */

import { PaymentStatus, ResponseType } from './constants.js';

export interface McpContent {
    type: "text";
    text: string;
}

export interface PaymentAnnotation {
    payment: {
        status: string;
        payment_id?: string;
        payment_url?: string;
        reason?: string;
        next_step?: string;
    };
}

export interface McpResponse {
    content: McpContent[];
    annotations?: PaymentAnnotation;
    status?: string;
    message?: string;
    payment_id?: string;
    payment_url?: string;
    next_step?: string;
    structured_content?: any;
    data?: any;
    raw?: any;
}

/**
 * Build a standard MCP response
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
    const response: McpResponse = {
        content: [{ type: "text", text: message }],
        status,
        message,
    };

    // Add payment annotations if payment info provided
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

    // Add top-level fields for compatibility
    if (options?.paymentId) response.payment_id = options.paymentId;
    if (options?.paymentUrl) response.payment_url = options.paymentUrl;
    if (options?.nextStep) response.next_step = options.nextStep;
    if (options?.rawResult) response.raw = options.rawResult;

    // Add structured content for two-step flow
    if (options?.nextStep && options?.paymentUrl) {
        const structuredData = {
            payment_url: options.paymentUrl,
            payment_id: options.paymentId,
            next_step: options.nextStep,
            status: status === ResponseType.PENDING ? 'payment_required' : `payment_${status}`,
            ...(options.amount && { amount: options.amount }),
            ...(options.currency && { currency: options.currency }),
        };
        response.structured_content = structuredData;
        response.data = structuredData;
    }

    return response;
}

/**
 * Build an error response
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
 * Build a payment pending response
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
 * Build a payment canceled response
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
 * Build a successful tool execution response
 */
export function buildSuccessResponse(
    toolResult: any,
    paymentId?: string
): McpResponse {
    // If tool result already has proper MCP structure, enhance it
    if (toolResult && Array.isArray(toolResult.content)) {
        if (paymentId) {
            try {
                toolResult.annotations = {
                    ...toolResult.annotations,
                    payment: { status: PaymentStatus.PAID, payment_id: paymentId },
                };
            } catch { /* ignore */ }
        }
        return toolResult;
    }

    // Otherwise, synthesize a response
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
 * Format a payment prompt message for two-step flow
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