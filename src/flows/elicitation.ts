// lib/ts/paymcp/src/flows/elicitation.ts
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import type { McpServerLike } from "../types/mcp.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { PriceConfig, ToolExtraLike } from "../types/config.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { Logger } from "../types/logger.js";
import { normalizeStatus } from "../utils/payment.js";
import { paymentPromptMessage } from "../utils/messages.js";
import { z } from "zod";

// Used for extra.sendRequest() result validation; accept any response shape.
const Z_ANY = z.any();

/**
 * Minimal "blank" schema: request no structured fields.
 * Many clients (e.g., FastMCP Python) will surface Accept / Decline / Cancel UI only.
 * This mirrors the Python `ctx.elicit(..., response_type=None)` pattern.
 */
const SimpleActionSchema = {
  type: "object",
  properties: {},
  required: [],
} as const;

/**
 * Wrap a tool handler with an *elicitation-based* payment flow:
 * 1. Create a payment session.
 * 2. Ask the user (via ctx.elicit) to confirm / complete payment.
 * 3. Poll provider for payment status.
 * 4. If paid -> call the original tool handler.
 * 5. If canceled -> return a structured canceled response.
 * 6. If still unpaid after N attempts -> return pending status so the caller can retry.
 */
export const makePaidWrapper: PaidWrapperFactory = (
  func,
  _server: McpServerLike,
  provider: BasePaymentProvider,
  priceInfo: PriceConfig,
  toolName: string,
  logger?: Logger,
  stateStore?: StateStoreProvider
) => {
  const log: Logger = logger ?? (provider as any).logger ?? console;

  async function wrapper(paramsOrExtra: any, maybeExtra?: ToolExtraLike) {
    log.debug?.(`[PayMCP:Elicitation] wrapper invoked for tool=${toolName} argsLen=${arguments.length}`);

    // The MCP TS SDK calls tool callbacks as either (args, extra) when an inputSchema is present,
    // or (extra) when no inputSchema is defined. We normalize here. citeturn5view0
    const hasArgs = arguments.length === 2;
    log.debug?.(`[PayMCP:Elicitation] hasArgs=${hasArgs}`);
    const toolArgs = hasArgs ? paramsOrExtra : undefined;
    const extra: ToolExtraLike = hasArgs ? (maybeExtra as ToolExtraLike) : (paramsOrExtra as ToolExtraLike);

    // Extract session ID from extra context
    const sessionId = extra?.sessionId;

    const elicitSupported = typeof (extra as any)?.sendRequest === "function";
    if (!elicitSupported) {
      log.warn?.(`[PayMCP:Elicitation] client lacks sendRequest(); falling back to error result.`);
      return {
        content: [{ type: "text", text: "Client does not support the selected payment flow." }],
        annotations: { payment: { status: "error", reason: "elicitation_not_supported" } },
        status: "error",
        message: "Client does not support the selected payment flow",
      };
    }

    // Check for existing payment state if we have a session ID and state store
    let paymentId: string | undefined;
    let paymentUrl: string | undefined;

    if (sessionId && stateStore) {
      log.debug?.(`[PayMCP:Elicitation] Checking state store for sessionId=${sessionId}`);
      const state = await stateStore.get(sessionId);

      if (state) {
        log.info?.(`[PayMCP:Elicitation] Found existing payment state for sessionId=${sessionId}`);
        paymentId = state.payment_id;
        paymentUrl = state.payment_url;
        const storedArgs = state.tool_args;
        const storedToolName = state.tool_name;

        // Check payment status with provider
        try {
          const status = normalizeStatus(await provider.getPaymentStatus(paymentId));
          log.info?.(`[PayMCP:Elicitation] Payment status for ${paymentId}: ${status}`);

          if (status === "paid") {
            // Payment already completed! Execute tool with original arguments
            log.info?.(`[PayMCP:Elicitation] Previous payment detected, executing with original request`);

            // Clean up state
            await stateStore.delete(sessionId);

            // Use stored arguments if they were for this function
            if (storedToolName === toolName) {
              // Use stored args instead of current ones
              const result = await callOriginal(func, storedArgs?.params, extra);
              return result;
            } else {
              // Different function, just execute normally
              return await callOriginal(func, toolArgs, extra);
            }
          } else if (status === "pending") {
            // Payment still pending, continue with existing payment
            log.info?.(`[PayMCP:Elicitation] Payment still pending, continuing with existing payment`);
            // Continue to elicitation with existing payment
          } else if (status === "canceled") {
            // Payment failed, clean up and create new one
            log.info?.(`[PayMCP:Elicitation] Previous payment canceled, creating new payment`);
            await stateStore.delete(sessionId);
            paymentId = undefined;
            paymentUrl = undefined;
          }
        } catch (err) {
          log.error?.(`[PayMCP:Elicitation] Error checking payment status: ${err}`);
          // If we can't check status, create a new payment
          if (stateStore) await stateStore.delete(sessionId);
          paymentId = undefined;
          paymentUrl = undefined;
        }
      }
    }

    // 1. Create payment session if needed
    if (!paymentId) {
      const payment = await provider.createPayment(
        priceInfo.amount,
        priceInfo.currency,
        `${toolName}() execution fee`
      );
      paymentId = payment.paymentId;
      paymentUrl = payment.paymentUrl;
      log.debug?.(`[PayMCP:Elicitation] created payment id=${paymentId} url=${paymentUrl}`);

      // Store payment state if we have session ID and state store
      if (sessionId && stateStore) {
        log.info?.(`[PayMCP:Elicitation] Storing payment state for sessionId=${sessionId}`);
        await stateStore.put(sessionId, {
          session_id: sessionId,
          payment_id: paymentId,
          payment_url: paymentUrl,
          tool_name: toolName,
          tool_args: { params: toolArgs },  // Store args for replay
          status: 'requested',
          created_at: Date.now()
        });
      }
    }

    // 2. Run elicitation loop (client confirms payment)
    let userAction: "accept" | "decline" | "cancel" | "unknown" = "unknown";
    let paymentStatus: string | undefined;

    try {
      log.debug?.(`[PayMCP:Elicitation] starting elicitation loop for paymentId=${paymentId}`);
      const loopResult = await runElicitationLoop(
        extra,
        paymentPromptMessage(paymentUrl, priceInfo.amount, priceInfo.currency),
        provider,
        paymentId,
        paymentUrl,
        5,
        log
      );
      log.debug?.(`[PayMCP:Elicitation] elicitation loop returned action=${loopResult.action} status=${loopResult.status}`);
      userAction = loopResult.action;
      paymentStatus = loopResult.status;
    } catch (err) {
      log.warn?.(`[PayMCP:Elicitation] elicitation loop error: ${String(err)}`);
      userAction = "unknown";
      // Don't delete state on timeout - payment might still complete
      if (sessionId && stateStore) {
        const state = await stateStore.get(sessionId);
        if (state) {
          state.status = 'timeout';
          await stateStore.put(sessionId, state);
        }
      }
    }

    // 3. Double‑check with provider just in case
    log.debug?.(`[PayMCP:Elicitation] provider status check (initial=${paymentStatus ?? "none"})`);
    if (paymentStatus === undefined || paymentStatus === null || paymentStatus === "") {
      try {
        paymentStatus = await provider.getPaymentStatus(paymentId);
        log.debug?.(`[PayMCP:Elicitation] provider.getPaymentStatus(${paymentId}) -> ${paymentStatus}`);
        paymentStatus = normalizeStatus(paymentStatus);
      } catch {
        paymentStatus = "unknown";
      }
    }

    if (paymentStatus === "unsupported" /* или loopResult.status === "unsupported" */) {
      return {
        content: [{ type: "text", text: "Client does not support the selected payment flow." }],
        annotations: { payment: { status: "error", reason: "elicitation_not_supported" } },
        status: "error",
        message: "Client does not support the selected payment flow.",
      };
    }

    if (normalizeStatus(paymentStatus) === "paid" || userAction === "accept") {
      log.info?.(`[PayMCP:Elicitation] payment confirmed; invoking original tool ${toolName}`);

      // Update state to paid if we have state store
      if (sessionId && stateStore) {
        const state = await stateStore.get(sessionId);
        if (state) {
          state.status = 'paid';
          await stateStore.put(sessionId, state);
        }
      }

      const toolResult = await callOriginal(func, toolArgs, extra);

      // Clean up state after successful execution
      if (sessionId && stateStore) {
        await stateStore.delete(sessionId);
      }
      // Ensure toolResult has required MCP 'content' field; if not, synthesize text.
      if (!toolResult || !Array.isArray((toolResult as any).content)) {
        return {
          content: [{ type: "text", text: "Tool completed after payment." }],
          annotations: { payment: { status: "paid", payment_id: paymentId } },
          raw: toolResult,
        };
      }
      // augment annotation
      try {
        (toolResult as any).annotations = {
          ...(toolResult as any).annotations,
          payment: { status: "paid", payment_id: paymentId },
        };
      } catch { /* ignore */ }
      return toolResult;
    }

    if (normalizeStatus(paymentStatus) === "canceled" || userAction === "cancel") {
      log.info?.(`[PayMCP:Elicitation] payment canceled by user or provider (status=${paymentStatus}, action=${userAction})`);

      // Clean up state on cancellation
      if (sessionId && stateStore) {
        await stateStore.delete(sessionId);
      }

      return {
        content: [{ type: "text", text: "Payment canceled by user." }],
        annotations: { payment: { status: "canceled", payment_id: paymentId } },
        payment_url: paymentUrl,
        status: "canceled",
        message: "Payment canceled by user",
      };
    }

    // Otherwise payment not yet received
    log.info?.(`[PayMCP:Elicitation] payment still pending after elicitation attempts; returning pending result.`);

    // Keep state for pending payments
    if (sessionId && stateStore) {
      const state = await stateStore.get(sessionId);
      if (state) {
        state.status = 'pending';
        await stateStore.put(sessionId, state);
      }
    }

    return {
      content: [{ type: "text", text: "Payment not yet received. Open the link and try again." }],
      annotations: { payment: { status: "pending", payment_id: paymentId, next_step: toolName } },
      payment_url: paymentUrl,
      status: "pending",
      message: "Payment not yet received. Open the link and try again.",
      payment_id: String(paymentId),
      next_step: toolName,
    };
  }

  return wrapper as unknown as ToolHandler;
};

interface ElicitLoopResult {
  action: "accept" | "decline" | "cancel" | "unknown";
  status: string; // raw provider status (e.g., paid, pending, canceled)
}

/**
 * Elicitation loop: prompt the user up to N times and poll the provider for status.
 * Returns one of: 'paid' | 'canceled' | 'pending'.
 *
 * Uses extra.sendRequest to send elicitation/create request.
 */
async function runElicitationLoop(
  extra: ToolExtraLike,
  message: string,
  provider: BasePaymentProvider,
  paymentId: string,
  paymentUrl: string,
  maxAttempts = 5,
  log: Logger = console
): Promise<ElicitLoopResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    log.debug?.(`[PayMCP:Elicitation] loop attempt=${attempt + 1}/${maxAttempts}`);
    // Send an elicitation/create request. See MCP spec. citeturn1view2
    const req = {
      method: "elicitation/create",
      params: {
        message,
        paymentId: paymentId,
        paymentUrl: paymentUrl,
        requestedSchema: SimpleActionSchema,
      },
    } as const;
    let elicitation: any;
    try {
      elicitation = await (extra.sendRequest
        ? extra.sendRequest(req, Z_ANY) // pass permissive schema; avoids undefined.parse crash
        : Promise.reject(new Error("No sendRequest()")));
    } catch (err: any) {
      log.warn?.(`[PayMCP:Elicitation] elicitation request failed (attempt=${attempt + 1}): ${String(err)}`);
      // fall through: we will still poll provider and possibly retry
      //elicitation = { action: "unknown" };
      if (err?.code === -32601 || /Method not found/i.test(String(err))) {
        log.warn?.(`[PayMCP:Elicitation] Returning unsupported error`);
        return { action: "unknown", status: "unsupported" };
      }
      return { action: "unknown", status: normalizeStatus("error") };
    }

    // FastMCP Python returns either top-level `action` or result.action; accept both.
    const action = (elicitation && typeof elicitation === "object"
      ? (elicitation as any).action ?? (elicitation as any).result?.action
      : undefined) ?? "unknown";
    log.debug?.(`[PayMCP:Elicitation] elicitation response action=${action}`);

    log.debug?.(`Elicitation`, elicitation);

    // Always check provider status after each elicitation exchange.
    const status = await provider.getPaymentStatus(paymentId);
    log.debug?.(`[PayMCP:Elicitation] provider status during loop: ${status}`);

    if (action === "cancel" || action === "decline") {
      log.info?.(`[PayMCP:Elicitation] user canceled/declined during elicitation.`);
      return { action: "cancel", status: normalizeStatus(status) };
    }

    if (normalizeStatus(status) === "paid") {
      return { action: "accept", status: "paid" };
    }
    // otherwise: pending; fall through to next attempt

  }
  // Exhausted attempts; still not paid.
  return { action: "unknown", status: "pending" };
}

/** Safely invoke the original tool handler preserving args. */
async function callOriginal(func: ToolHandler, args: any | undefined, extra: ToolExtraLike) {
  if (args !== undefined) {
    return await func(args, extra);
  } else {
    return await func(extra);
  }
}