/**
 * User-facing message generation utilities for TypeScript payment flows.
 *
 * This module creates consistent, user-friendly messages for payment prompts
 * and tool descriptions. These messages are shown to users during payment flows
 * to guide them through the payment process and set clear expectations.
 *
 * The messages are designed to be:
 * 1. Clear and concise
 * 2. Action-oriented
 * 3. Consistent across all payment flows
 * 4. Informative about costs and next steps
 *
 * This TypeScript version mirrors the Python implementation in paymcp/utils/messages.py
 * to ensure consistent messaging across both implementations.
 */

import { PriceConfig } from "../types/config.js";

/**
 * Enhance a tool's description with pricing information for transparency.
 *
 * This function appends pricing details to tool descriptions so users
 * (and LLMs) know a tool requires payment before they invoke it.
 * This transparency helps set expectations and avoid payment surprises.
 *
 * The enhanced description appears in:
 * - Tool listing (when client lists available tools)
 * - Tool help/documentation
 * - Error messages when payment is required
 *
 * @param desc - Original tool description from the developer.
 *               Can be undefined for tools without descriptions.
 * @param price - Pricing configuration object.
 *                Must contain amount and currency fields.
 *
 * @returns Enhanced description with pricing information appended.
 *
 * @example
 * ```typescript
 * const desc = "Generate an image from text prompt";
 * const price = { amount: 2.50, currency: "USD" };
 * const enhanced = appendPriceToDescription(desc, price);
 * // Returns: "Generate an image from text prompt.
 * // This is a paid function: 2.50 USD.
 * // Payment will be requested during execution."
 * ```
 */
export function appendPriceToDescription(desc: string | undefined, price: PriceConfig): string {
    // Normalize the base description, handling undefined case
    const base = (desc ?? "").trim();

    // Format the pricing message with clear cost information
    const cost = `.\nThis is a paid function: ${price.amount} ${price.currency}.\nPayment will be requested during execution.`;

    // Append to original description or use as standalone message
    return base ? `${base}${cost}` : cost;
}

/**
 * Generate a payment prompt message for user instructions.
 *
 * This creates a standardized message that tells users how to complete
 * payment for a tool execution. The message is clear, direct, and includes
 * all necessary information for the user to proceed.
 *
 * Used by:
 * - Two-step flows: Directs users to complete payment before confirmation
 * - Progress flows: Shows payment instructions during processing
 * - Elicitation flows: Provides fallback instructions if webview fails
 *
 * @param url - Payment URL where user completes payment.
 *              Must be a valid, accessible URL.
 * @param amount - Payment amount in the specified currency.
 *                 Example: 5.99
 * @param currency - Currency code for the payment amount.
 *                  Example: "USD", "EUR", "GBP"
 *
 * @returns Formatted payment prompt message.
 *
 * @example
 * ```typescript
 * const message = paymentPromptMessage(
 *     "https://checkout.stripe.com/pay_abc123",
 *     5.00,
 *     "USD"
 * );
 * // Returns: "To continue, please pay 5.00 USD at:
 * // https://checkout.stripe.com/pay_abc123"
 * ```
 */
export function paymentPromptMessage(url: string, amount: number, currency: string): string {
    return `To continue, please pay ${amount} ${currency} at:\n${url}`;
}