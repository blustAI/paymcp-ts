/**
 * Common utilities for payment flows
 */

import type { ToolHandler } from "../types/flows.js";
import type { ToolExtraLike } from "../types/config.js";
import type { Logger } from "../types/logger.js";

/**
 * Safely invoke the original tool handler preserving the (args, extra) vs (extra)
 * call shapes used by the MCP TS SDK.
 *
 * This eliminates duplicate callOriginal functions across all flow files.
 */
export async function callOriginalTool(
    func: ToolHandler,
    toolArgs: any | undefined,
    extra: ToolExtraLike
): Promise<any> {
    if (toolArgs !== undefined) {
        return await func(toolArgs, extra);
    } else {
        return await func(extra);
    }
}

/**
 * Normalize tool call arguments from MCP SDK
 * Returns { hasArgs, toolArgs, extra }
 */
export function normalizeToolArgs(
    paramsOrExtra: any,
    maybeExtra?: any
): {
    hasArgs: boolean;
    toolArgs: any | undefined;
    extra: ToolExtraLike;
} {
    const hasArgs = arguments.length === 2;
    const toolArgs = hasArgs ? paramsOrExtra : undefined;
    const extra: ToolExtraLike = hasArgs
        ? (maybeExtra as ToolExtraLike)
        : (paramsOrExtra as ToolExtraLike);

    return { hasArgs, toolArgs, extra };
}

/**
 * Utility to delay execution
 */
export const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if client has aborted the operation
 */
export function isClientAborted(extra: ToolExtraLike): boolean {
    return !!(extra as any)?.signal?.aborted;
}

/**
 * Log wrapper with consistent formatting
 */
export function logFlow(
    log: Logger | undefined,
    flowName: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...args: any[]
): void {
    const prefix = `[PayMCP:${flowName}]`;
    const fullMessage = `${prefix} ${message}`;

    if (log && typeof log[level] === 'function') {
        log[level](fullMessage, ...args);
    } else if (level === 'error' || level === 'warn') {
        console[level](fullMessage, ...args);
    }
}