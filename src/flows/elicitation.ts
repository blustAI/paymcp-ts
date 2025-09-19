// lib/ts/paymcp/src/flows/elicitation.ts
import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import type { McpServerLike } from "../types/mcp.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { PriceConfig } from "../types/config.js";
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
import {
  callOriginalTool,
  normalizeToolArgs,
  logFlow
} from "../utils/flow.js";
import {
  buildErrorResponse,
  buildCanceledResponse,
  buildPendingResponse,
  buildSuccessResponse
} from "../utils/response.js";
import { PaymentStatus, Timing } from "../utils/constants.js";
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

  async function wrapper(paramsOrExtra: any, maybeExtra?: any) {
    const { toolArgs, extra } = normalizeToolArgs(paramsOrExtra, maybeExtra);

    logFlow(log, 'Elicitation', 'debug',
      `wrapper invoked for tool=${toolName}`);

    // Extract session ID from extra context
    const sessionId = extractSessionId(extra, log);

    const elicitSupported = typeof (extra as any)?.sendRequest === "function";
    if (!elicitSupported) {
      logFlow(log, 'Elicitation', 'warn',
        'client lacks sendRequest(); falling back to error result');
      return buildErrorResponse(
        "Client does not support the selected payment flow",
        "elicitation_not_supported"
      );
    }

    // Check for existing payment state
    const checkResult = await checkExistingPayment(
      sessionId, stateStore, provider, toolName, { params: toolArgs }, log
    );

    // If payment was already completed, execute immediately
    if (checkResult.shouldExecuteImmediately) {
      const argsToUse = checkResult.storedArgs?.params || toolArgs;
      return await callOriginalTool(func, argsToUse, extra);
    }

    // Use existing payment if available
    let paymentId = checkResult.paymentId;
    let paymentUrl = checkResult.paymentUrl;

    // Create payment session if needed
    if (!paymentId) {
      const payment = await provider.createPayment(
        priceInfo.amount,
        priceInfo.currency,
        `${toolName}() execution fee`
      );
      paymentId = payment.paymentId;
      paymentUrl = payment.paymentUrl;

      logFlow(log, 'Elicitation', 'debug',
        `created payment id=${paymentId} url=${paymentUrl}`);

      // Store payment state
      await savePaymentState(
        sessionId, stateStore, paymentId, paymentUrl,
        toolName, { params: toolArgs }, PaymentStatus.REQUESTED, log
      );
    }

    // Run elicitation loop (client confirms payment)
    let userAction: "accept" | "decline" | "cancel" | "unknown" = "unknown";
    let paymentStatus: string | undefined;

    try {
      logFlow(log, 'Elicitation', 'debug',
        `starting elicitation loop for paymentId=${paymentId}`);

      const loopResult = await runElicitationLoop(
        extra,
        paymentPromptMessage(paymentUrl!, priceInfo.amount, priceInfo.currency),
        provider,
        paymentId,
        paymentUrl!,
        5,
        log
      );

      logFlow(log, 'Elicitation', 'debug',
        `elicitation loop returned action=${loopResult.action} status=${loopResult.status}`);

      userAction = loopResult.action;
      paymentStatus = loopResult.status;
    } catch (err) {
      logFlow(log, 'Elicitation', 'warn',
        `elicitation loop error: ${String(err)}`);
      userAction = "unknown";
      // Don't delete state on timeout - payment might still complete
      await updatePaymentStatus(sessionId, stateStore, PaymentStatus.TIMEOUT, log);
    }

    // Double-check with provider just in case
    logFlow(log, 'Elicitation', 'debug',
      `provider status check (initial=${paymentStatus ?? "none"})`);

    if (!paymentStatus) {
      try {
        paymentStatus = normalizeStatus(await provider.getPaymentStatus(paymentId));
        logFlow(log, 'Elicitation', 'debug',
          `provider.getPaymentStatus(${paymentId}) -> ${paymentStatus}`);
      } catch {
        paymentStatus = "unknown";
      }
    }

    if (paymentStatus === PaymentStatus.UNSUPPORTED) {
      return buildErrorResponse(
        "Client does not support the selected payment flow",
        "elicitation_not_supported"
      );
    }

    if (normalizeStatus(paymentStatus) === PaymentStatus.PAID || userAction === "accept") {
      logFlow(log, 'Elicitation', 'info',
        `payment confirmed; invoking original tool ${toolName}`);

      // Update state to paid
      await updatePaymentStatus(sessionId, stateStore, PaymentStatus.PAID, log);

      const toolResult = await callOriginalTool(func, toolArgs, extra);

      // Clean up state after successful execution
      await cleanupPaymentState(sessionId, stateStore, log);

      return buildSuccessResponse(toolResult, paymentId);
    }

    if (normalizeStatus(paymentStatus) === PaymentStatus.CANCELED || userAction === "cancel") {
      logFlow(log, 'Elicitation', 'info',
        `payment canceled by user or provider (status=${paymentStatus}, action=${userAction})`);

      // Clean up state on cancellation
      await cleanupPaymentState(sessionId, stateStore, log);

      return buildCanceledResponse(
        "Payment canceled by user",
        paymentId,
        paymentUrl
      );
    }

    // Otherwise payment not yet received
    logFlow(log, 'Elicitation', 'info',
      'payment still pending after elicitation attempts; returning pending result');

    // Keep state for pending payments
    await updatePaymentStatus(sessionId, stateStore, PaymentStatus.PENDING, log);

    return buildPendingResponse(
      "Payment not yet received. Open the link and try again.",
      String(paymentId),
      paymentUrl!,
      toolName,
      priceInfo.amount,
      priceInfo.currency
    );
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
  extra: any,
  message: string,
  provider: BasePaymentProvider,
  paymentId: string,
  paymentUrl: string,
  maxAttempts = 5,
  log: Logger = console
): Promise<ElicitLoopResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    logFlow(log, 'Elicitation', 'debug',
      `loop attempt=${attempt + 1}/${maxAttempts}`);

    // Send an elicitation/create request
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
        ? extra.sendRequest(req, Z_ANY)
        : Promise.reject(new Error("No sendRequest()")));
    } catch (err: any) {
      logFlow(log, 'Elicitation', 'warn',
        `elicitation request failed (attempt=${attempt + 1}): ${String(err)}`);

      if (err?.code === -32601 || /Method not found/i.test(String(err))) {
        logFlow(log, 'Elicitation', 'warn', 'Returning unsupported error');
        return { action: "unknown", status: PaymentStatus.UNSUPPORTED };
      }
      return { action: "unknown", status: normalizeStatus("error") };
    }

    // FastMCP Python returns either top-level `action` or result.action; accept both.
    const action = (elicitation && typeof elicitation === "object"
      ? (elicitation as any).action ?? (elicitation as any).result?.action
      : undefined) ?? "unknown";

    logFlow(log, 'Elicitation', 'debug', `elicitation response action=${action}`);

    // Always check provider status after each elicitation exchange.
    const status = await provider.getPaymentStatus(paymentId);
    logFlow(log, 'Elicitation', 'debug', `provider status during loop: ${status}`);

    if (action === "cancel" || action === "decline") {
      logFlow(log, 'Elicitation', 'info', 'user canceled/declined during elicitation');
      return { action: "cancel", status: normalizeStatus(status) };
    }

    if (normalizeStatus(status) === PaymentStatus.PAID) {
      return { action: "accept", status: PaymentStatus.PAID };
    }
    // otherwise: pending; fall through to next attempt
  }

  // Exhausted attempts; still not paid.
  return { action: "unknown", status: PaymentStatus.PENDING };
}