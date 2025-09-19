// Two-step payment flow
//
// Flow:
//   Step 1 (initiate): when the original tool is called, we create a payment,
//   stash the original tool arguments, and return a payment URL + payment_id
//   + the *name of a confirmation tool* the caller should invoke after paying.
//   We do NOT invoke the wrapped tool yet.
//
//   Step 2 (confirm): a dynamically registered tool named
//   `confirm_<toolName>_payment` accepts { payment_id }, verifies the payment
//   status with the provider, retrieves the stashed args, and—if paid—invokes
//   the original tool handler. If payment is not complete, it returns an error.
//
// NOTE:
// - Stored args are kept in a process-local Map. For production you may want
//   Redis or another store to survive process restarts.
// - We return MCP-compatible result objects that always include `content` to
//   avoid downstream schema errors (e.g., Pydantic in Python clients).

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import type { McpServerLike } from "../types/mcp.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { PriceConfig } from "../types/config.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { paymentPromptMessage } from "../utils/messages.js";
import { Logger } from "../types/logger.js";
import { normalizeStatus } from "../utils/payment.js";
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
  buildPendingResponse,
  buildErrorResponse,
  buildSuccessResponse,
  formatTwoStepMessage
} from "../utils/response.js";
import { PaymentStatus } from "../utils/constants.js";
import { z } from "zod";

// Simple in-memory arg storage. Keyed by paymentId string.
const PENDING_ARGS = new Map<
  string,
  {
    args: any;
    ts: number;
  }
>();

/**
 * Register (or return existing) confirmation tool.
 * Returns the tool name actually registered.
 */
function ensureConfirmTool(
  server: McpServerLike,
  provider: BasePaymentProvider,
  toolName: string,
  originalHandler: ToolHandler,
  log?: Logger,
  stateStore?: StateStoreProvider
): string {
  const confirmToolName = `confirm_${toolName}_payment`;

  logFlow(log, 'TwoStep', 'debug', `ensureConfirmTool(${confirmToolName})`);

  // Detect if already registered
  const srvAny = server as any;
  const toolsMap: Map<
    string,
    { config: any; handler: ToolHandler }
  > | undefined = srvAny?.tools;

  if (toolsMap?.has(confirmToolName)) {
    logFlow(log, 'TwoStep', 'debug', 'confirm tool already registered');
    return confirmToolName;
  }

  // Minimal param schema (Zod) for confirmation tool
  const inputSchema = {
    payment_id: z.string(),
  };

  // Confirmation handler: verify payment, retrieve saved args, invoke original tool
  const confirmHandler: ToolHandler = async (
    paramsOrExtra: any,
    maybeExtra?: any
  ) => {
    const { hasArgs, toolArgs: params, extra } = normalizeToolArgs(paramsOrExtra, maybeExtra);

    logFlow(log, 'TwoStep', 'info', `confirm handler invoked for ${toolName}`);

    const paymentId: string | undefined = hasArgs
      ? (params as any)?.payment_id
      : (extra as any)?.payment_id;

    logFlow(log, 'TwoStep', 'debug', `confirm received payment_id=${paymentId}`);

    if (!paymentId) {
      return buildErrorResponse("Missing payment_id");
    }

    // Try to retrieve args from state store using optimized lookup
    let stored: { args: any; ts: number } | undefined;
    let sessionId: string | undefined;

    if (stateStore) {
      // Try optimized O(1) lookup using payment_id index
      let state = await stateStore.getByPaymentId(paymentId);
      if (state) {
        stored = {
          args: state.tool_args?.params,
          ts: state.created_at || Date.now()
        };
        sessionId = state.session_id;
        logFlow(log, 'TwoStep', 'debug',
          'Retrieved args via payment_id index');
      } else {
        // Fallback: Try direct key lookup (for backward compatibility)
        state = await stateStore.get(paymentId);
        if (state) {
          stored = {
            args: state.tool_args?.params,
            ts: state.created_at || Date.now()
          };
          sessionId = state.session_id;
          logFlow(log, 'TwoStep', 'debug',
            'Retrieved args from state store using payment_id as key');
        }
      }
    }

    // Fall back to legacy PENDING_ARGS if not found in state store
    if (!stored) {
      stored = PENDING_ARGS.get(String(paymentId));
      logFlow(log, 'TwoStep', 'debug',
        `Retrieved args from legacy PENDING_ARGS, keys=${Array.from(PENDING_ARGS.keys()).join(",")}`);
    }

    if (!stored) {
      return buildErrorResponse(
        "Unknown or expired payment_id",
        undefined,
        paymentId
      );
    }

    // Check provider status
    let status: string;
    try {
      status = await provider.getPaymentStatus(paymentId);
      logFlow(log, 'TwoStep', 'debug',
        `provider.getPaymentStatus(${paymentId}) -> ${status}`);
    } catch (err) {
      return buildErrorResponse(
        `Failed to check payment status: ${(err as Error).message}`,
        "status_check_failed",
        paymentId
      );
    }

    const statusLc = String(status).toLowerCase();
    if (statusLc !== PaymentStatus.PAID) {
      return buildErrorResponse(
        `Payment status is ${status}, expected 'paid'`,
        undefined,
        paymentId
      );
    }

    // We're good—call original tool
    logFlow(log, 'TwoStep', 'info',
      `payment confirmed; calling original tool ${toolName}`);

    const toolResult = await callOriginalTool(
      originalHandler,
      stored.args,
      extra
    );

    // Clean up based on where we got the args from
    if (sessionId && stateStore) {
      // Clean up the primary entry
      // The StateStore will automatically clean up the payment_id index
      await cleanupPaymentState(sessionId, stateStore, log);
      logFlow(log, 'TwoStep', 'debug',
        `Cleaned up state for session_id=${sessionId}, payment_id index auto-removed`);
    } else {
      // Args came from legacy PENDING_ARGS, remove from there
      PENDING_ARGS.delete(String(paymentId));
    }

    return buildSuccessResponse(toolResult);
  };

  // Register the confirm tool (no price, so PayMCP will not wrap it again)
  srvAny.registerTool(
    confirmToolName,
    {
      title: `Confirm payment for ${toolName}`,
      description: `Confirm payment and execute ${toolName}()`,
      inputSchema
    },
    confirmHandler
  );

  return confirmToolName;
}

export const makePaidWrapper: PaidWrapperFactory = (options) => {
  const { func, server, provider, priceInfo, toolName, logger, stateStore } = options;
  const log: Logger = logger ?? (provider as any).logger ?? console;

  // Eagerly register confirm tool so the client sees it in the initial tool list
  const confirmToolName = ensureConfirmTool(
    server,
    provider,
    toolName,
    func,
    log,
    stateStore
  );

  async function twoStepWrapper(paramsOrExtra: any, maybeExtra?: any) {
    const { hasArgs, toolArgs, extra } = normalizeToolArgs(paramsOrExtra, maybeExtra);

    logFlow(log, 'TwoStep', 'debug',
      `initiate wrapper invoked for ${toolName}, hasArgs=${hasArgs}`);

    // Extract session ID from extra context
    const sessionId = extractSessionId(extra, log);

    // Check for existing payment state
    const checkResult = await checkExistingPayment(
      sessionId, stateStore, provider, toolName, { params: toolArgs }, log
    );

    // If payment was already completed, execute immediately
    if (checkResult.shouldExecuteImmediately) {
      const argsToUse = checkResult.storedArgs?.params || toolArgs;
      return await callOriginalTool(func, argsToUse, extra);
    }

    // If payment exists but is still pending, return existing payment info
    if (checkResult.paymentId && checkResult.paymentUrl) {
      const message = formatTwoStepMessage(
        `Payment still pending: ${paymentPromptMessage(
          checkResult.paymentUrl,
          priceInfo.amount,
          priceInfo.currency
        )}`,
        checkResult.paymentUrl,
        checkResult.paymentId,
        confirmToolName
      );

      return buildPendingResponse(
        JSON.stringify(message),
        checkResult.paymentId,
        checkResult.paymentUrl,
        confirmToolName,
        priceInfo.amount,
        priceInfo.currency
      );
    }

    // Create payment
    const { paymentId, paymentUrl } = await provider.createPayment(
      priceInfo.amount,
      priceInfo.currency,
      `${toolName}() execution fee`
    );

    const pidStr = String(paymentId);

    // Store payment state - StateStore now automatically indexes by payment_id
    await savePaymentState(
      sessionId, stateStore, paymentId, paymentUrl,
      toolName, { params: toolArgs }, PaymentStatus.REQUESTED, log
    );

    // Note: With the new payment_id index in StateStore, we no longer need
    // to store duplicate entries. The StateStore automatically maintains
    // a payment_id -> key index for O(1) lookups.
    if (!stateStore) {
      // Fall back to legacy PENDING_ARGS when no state store
      PENDING_ARGS.set(pidStr, { args: toolArgs, ts: Date.now() });
    }

    // Build message shown to user / LLM
    const message = formatTwoStepMessage(
      paymentPromptMessage(paymentUrl, priceInfo.amount, priceInfo.currency),
      paymentUrl,
      pidStr,
      confirmToolName
    );

    logFlow(log, 'TwoStep', 'info',
      `payment initiated pid=${pidStr} url=${paymentUrl} next=${confirmToolName}`);

    // Return step-1 response with proper structure
    return buildPendingResponse(
      JSON.stringify(message),
      pidStr,
      paymentUrl,
      confirmToolName,
      priceInfo.amount,
      priceInfo.currency
    );
  }

  return twoStepWrapper as unknown as ToolHandler;
};