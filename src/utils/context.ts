/**
 * Utility functions for extracting information from MCP context objects.
 */
import { Logger } from "../types/logger.js";

/**
 * Extract session ID from various possible locations in the context object.
 *
 * Different MCP implementations store session information in different places,
 * so this function tries multiple approaches to find it.
 *
 * @param extra - The extra/context object passed to the tool handler
 * @param log - Optional logger for debugging
 * @returns The session ID if found, undefined otherwise
 */
export function extractSessionId(extra: any, log?: Logger): string | undefined {
    if (!extra) {
        log?.debug?.("No context provided");
        return undefined;
    }

    let sessionId: string | undefined;

    // Try multiple approaches to get session ID

    // 1. Direct sessionId property
    if (extra?.sessionId) {
        sessionId = extra.sessionId;
        log?.debug?.(`Got sessionId from extra.sessionId: ${sessionId}`);
        return sessionId;
    }

    // 2. From session object
    if (extra?.session?.id) {
        sessionId = extra.session.id;
        log?.debug?.(`Got sessionId from extra.session.id: ${sessionId}`);
        return sessionId;
    }
    if (extra?.session?.sessionId) {
        sessionId = extra.session.sessionId;
        log?.debug?.(`Got sessionId from extra.session.sessionId: ${sessionId}`);
        return sessionId;
    }

    // 3. From meta attribute
    if (extra?.meta?.session_id) {
        sessionId = extra.meta.session_id;
        log?.debug?.(`Got sessionId from extra.meta.session_id: ${sessionId}`);
        return sessionId;
    }

    // 4. From request_id as fallback (temporary workaround for testing)
    if (extra?.requestId) {
        sessionId = `req_${extra.requestId}`;
        log?.info?.(`Using requestId as sessionId: ${sessionId}`);
        return sessionId;
    }
    if (extra?.request_id) {
        sessionId = `req_${extra.request_id}`;
        log?.info?.(`Using request_id as sessionId: ${sessionId}`);
        return sessionId;
    }

    log?.warn?.("No sessionId found in context");
    return undefined;
}

/**
 * Log debugging information about the context object.
 *
 * @param extra - The context object to inspect
 * @param log - Logger for output
 */
export function logContextInfo(extra: any, log?: Logger): void {
    if (!extra || !log) {
        return;
    }

    log.info?.(`Context type: ${typeof extra}`);

    // Log keys at the top level
    if (typeof extra === 'object') {
        log.debug?.(`Context keys: ${Object.keys(extra).join(', ')}`);
    }

    // Log specific attributes if they exist
    if (extra?.request_id) {
        log.info?.(`Request ID: ${extra.request_id}`);
    }
    if (extra?.requestId) {
        log.info?.(`Request ID: ${extra.requestId}`);
    }
    if (extra?.sessionId) {
        log.info?.(`Session ID: ${extra.sessionId}`);
    }
}