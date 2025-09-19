// lib/ts/paymcp/src/flows/elicitation.ts
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import type { McpServerLike } from "../types/mcp.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { PriceConfig, ToolExtraLike } from "../types/config.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { Logger } from "../types/logger.js";
import { normalizeStatus } from "../utils/payment.js";
import { paymentPromptMessage } from "../utils/messages.js";
import { extractSessionId, logContextInfo } from "../utils/context.js";
import {
  checkExistingPayment,
  savePaymentState,
  updatePaymentStatus,
  cleanupPaymentState
} from "../utils/state.js";
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

    // Extract session ID from extra context using utility function
    const sessionId = extractSessionId(extra, log);

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

    // Check for existing payment state using utility
    const checkResult = await checkExistingPayment(
      sessionId, stateStore, provider, toolName, { params: toolArgs }, log
    );

    // If payment was already completed, execute immediately
    if (checkResult.shouldExecuteImmediately) {
      const argsToUse = checkResult.storedArgs?.params || toolArgs;
      return await callOriginal(func, argsToUse, extra);
    }

    // Use existing payment if available
    let paymentId = checkResult.paymentId;
    let paymentUrl = checkResult.paymentUrl;

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

      // Store payment state using utility
      await savePaymentState(
        sessionId, stateStore, paymentId, paymentUrl,
        toolName, { params: toolArgs }, 'requested', log
      );
    }

    // 2. Run elicitation loop (client confirms payment)
    let userAction: "accept" | "decline" | "cancel" | "unknown" = "unknown";
    let paymentStatus: string | undefined;

    try {
      log.debug?.(`[PayMCP:Elicitation] starting elicitation loop for paymentId=${paymentId}`);
      const loopResult = await runElicitationLoop(
        extra,
        paymentPromptMessage(paymentUrl!, priceInfo.amount, priceInfo.currency),
        provider,
        paymentId,
        paymentUrl!,
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
      await updatePaymentStatus(sessionId, stateStore, 'timeout', log);
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

      // Update state to paid
      await updatePaymentStatus(sessionId, stateStore, 'paid', log);

      const toolResult = await callOriginal(func, toolArgs, extra);

      // Clean up state after successful execution
      await cleanupPaymentState(sessionId, stateStore, log);
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
      await cleanupPaymentState(sessionId, stateStore, log);

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
    await updatePaymentStatus(sessionId, stateStore, 'pending', log);

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