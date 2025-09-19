/**
 * Common utilities for payment flows and MCP tool execution in TypeScript.
 *
 * This module provides shared utilities that are used across all payment flow
 * implementations (elicitation, progress, sync, etc.) in the TypeScript version.
 * It centralizes common patterns to avoid code duplication and ensure consistent behavior.
 *
 * This TypeScript version mirrors the Python implementation in paymcp/utils/flow.py
 * while adapting to TypeScript/JavaScript conventions and the MCP TypeScript SDK.
 *
 * Key Features:
 * 1. Tool execution: Safe invocation of original tool handlers
 * 2. Argument normalization: Handle various MCP SDK argument formats
 * 3. Flow control: Client abort detection and timing utilities
 * 4. Logging: Consistent structured logging across flows
 *
 * These utilities are designed to work with any MCP client implementation
 * and provide a stable foundation for payment flow implementations.
 */

import type { ToolHandler } from "../types/flows.js";
import type { ToolExtraLike } from "../types/config.js";
import type { Logger } from "../types/logger.js";

/**
 * Safely invoke the original tool handler with its arguments after payment.
 *
 * This function provides a centralized way to execute the actual tool function
 * after payment has been confirmed. It handles the different call signatures
 * used by the MCP TypeScript SDK correctly.
 *
 * The MCP TS SDK supports two call patterns:
 * 1. func(args, extra) - When tool has parameters
 * 2. func(extra) - When tool has no parameters
 *
 * Critical for payment flows because:
 * 1. Tool execution must happen AFTER payment confirmation
 * 2. Original arguments must be preserved exactly
 * 3. MCP SDK call signature must be respected
 * 4. Error handling should be consistent across flows
 *
 * @param func - The original tool function to execute.
 *               Must follow MCP TypeScript SDK signature patterns.
 * @param toolArgs - Tool arguments if any were provided.
 *                   undefined means no arguments (use single-parameter form).
 * @param extra - MCP context object with session, logging, etc.
 *
 * @returns The return value from the original tool function.
 *          Type depends on what the tool returns.
 *
 * @throws Any exception raised by the original tool function.
 *         These should propagate to the MCP client for proper error handling.
 *
 * @example
 * ```typescript
 * // Tool with arguments
 * const result = await callOriginalTool(generateText,
 *     { prompt: "hello", model: "gpt-4" }, extra);
 *
 * // Tool without arguments
 * const result = await callOriginalTool(getCurrentTime, undefined, extra);
 * ```
 */
export async function callOriginalTool(
    func: ToolHandler,
    toolArgs: any | undefined,
    extra: ToolExtraLike
): Promise<any> {
    // Handle the two MCP SDK call patterns
    if (toolArgs !== undefined) {
        // Tool has parameters: use func(args, extra) pattern
        return await func(toolArgs, extra);
    } else {
        // Tool has no parameters: use func(extra) pattern
        return await func(extra);
    }
}

/**
 * Normalize tool call arguments from the MCP TypeScript SDK.
 *
 * The MCP TypeScript SDK can call tool handlers in different ways depending
 * on whether the tool has parameters. This function standardizes the input
 * format so payment flows can handle arguments consistently.
 *
 * MCP SDK call patterns:
 * - handler(extra) - No parameters
 * - handler(args, extra) - With parameters
 *
 * @param paramsOrExtra - First argument from MCP SDK.
 *                        Could be args object or extra context.
 * @param maybeExtra - Second argument from MCP SDK.
 *                     Present only when first arg is tool arguments.
 *
 * @returns Object with normalized arguments:
 *          - hasArgs: true if tool has parameters
 *          - toolArgs: the tool arguments (undefined if no args)
 *          - extra: the MCP context object
 *
 * @example
 * ```typescript
 * // Tool with args: handler(args, extra)
 * const { hasArgs, toolArgs, extra } = normalizeToolArgs(
 *     { prompt: "hello" },
 *     { sessionId: "123" }
 * );
 * // hasArgs = true, toolArgs = { prompt: "hello" }
 *
 * // Tool without args: handler(extra)
 * const { hasArgs, toolArgs, extra } = normalizeToolArgs(
 *     { sessionId: "123" }
 * );
 * // hasArgs = false, toolArgs = undefined
 * ```
 */
export function normalizeToolArgs(
    paramsOrExtra: any,
    maybeExtra?: any
): {
    hasArgs: boolean;
    toolArgs: any | undefined;
    extra: ToolExtraLike;
} {
    // Determine call pattern based on number of arguments
    const hasArgs = arguments.length === 2;

    // Extract arguments based on detected pattern
    const toolArgs = hasArgs ? paramsOrExtra : undefined;
    const extra: ToolExtraLike = hasArgs
        ? (maybeExtra as ToolExtraLike)
        : (paramsOrExtra as ToolExtraLike);

    return { hasArgs, toolArgs, extra };
}

/**
 * Asynchronous delay utility for payment flow timing.
 *
 * This provides consistent timing behavior across all payment flows.
 * It's used for:
 *
 * 1. Polling intervals: Checking payment status periodically
 * 2. User experience: Giving users time to process payment prompts
 * 3. Rate limiting: Avoiding overwhelming payment providers
 * 4. Retry logic: Implementing exponential backoff strategies
 *
 * @param ms - Number of milliseconds to delay.
 *             Can be fractional (e.g., 500.5 for 500.5ms).
 *
 * @returns Promise that resolves after the specified delay.
 *
 * @example
 * ```typescript
 * // Wait 2 seconds before checking payment status again
 * await delay(2000);
 *
 * // Brief pause for user experience
 * await delay(500);
 * ```
 */
export const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if the MCP client has aborted the current operation.
 *
 * MCP clients can cancel operations (like when a user closes a window or
 * hits Ctrl+C). This function provides a consistent way to detect such
 * cancellations across different MCP client implementations.
 *
 * Abort detection is important for:
 * 1. Resource cleanup: Stop payment polling when client disconnects
 * 2. User experience: Don't show completion messages to disconnected clients
 * 3. Provider efficiency: Avoid unnecessary API calls
 * 4. State management: Update payment state appropriately
 *
 * @param extra - MCP context object from the client.
 *                Different clients implement abort signaling differently.
 *
 * @returns true if the client has signaled an abort, false otherwise.
 *          Returns false if abort detection is not supported by the client.
 *
 * @example
 * ```typescript
 * if (isClientAborted(extra)) {
 *     logger.info("Client aborted, stopping payment check");
 *     return { error: "Operation canceled by user" };
 * }
 * ```
 */
export function isClientAborted(extra: ToolExtraLike): boolean {
    // Check for standard abort signal pattern
    // Some clients provide signal.aborted (following browser AbortSignal API)
    return !!(extra as any)?.signal?.aborted;
}

/**
 * Structured logging utility with consistent formatting across payment flows.
 *
 * This function provides standardized logging for all payment flows with:
 * 1. Consistent prefixes: [PayMCP:FlowName] for easy filtering
 * 2. Fallback handling: Print important messages even without a logger
 * 3. Level support: All standard logging levels
 * 4. Type safety: Proper TypeScript typing for logger functions
 *
 * Structured logging is crucial for:
 * - Debugging payment issues across different flows
 * - Monitoring payment success/failure rates
 * - Tracking flow performance and timing
 * - Correlating logs across different system components
 *
 * @param log - Logger instance to use.
 *              If undefined, important messages will print to console.
 * @param flowName - Name of the payment flow for log prefixing.
 *                   Examples: 'Progress', 'Elicitation', 'Sync', 'WebView'
 * @param level - Logging level to use.
 *                Valid values: 'debug', 'info', 'warn', 'error'
 * @param message - Log message template.
 *                  Can include format placeholders for args.
 * @param args - Additional arguments for message formatting.
 *
 * @example
 * ```typescript
 * logFlow(logger, "Elicitation", "info", "Payment %s confirmed", paymentId);
 * // Outputs: [PayMCP:Elicitation] Payment pay_123 confirmed
 *
 * logFlow(undefined, "Progress", "error", "Provider failed: %s", error);
 * // Prints: ERROR: [PayMCP:Progress] Provider failed: Connection timeout
 * ```
 */
export function logFlow(
    log: Logger | undefined,
    flowName: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...args: any[]
): void {
    // Create consistent prefix for all PayMCP logs
    const prefix = `[PayMCP:${flowName}]`;
    const fullMessage = `${prefix} ${message}`;

    if (log && typeof log[level] === 'function') {
        // Use the provided logger with the requested level
        log[level](fullMessage, ...args);
    } else if (level === 'error' || level === 'warn') {
        // No logger provided, but this is an important message
        // Print to console so it's not lost completely
        console[level](fullMessage, ...args);
    }
}