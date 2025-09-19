// Two‑step payment flow 
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
// - Stored args are kept in a process‑local Map. For production you may want
//   Redis or another store to survive process restarts.
// - We return MCP‑compatible result objects that always include `content` to
//   avoid downstream schema errors (e.g., Pydantic in Python clients).

/* eslint-disable @typescript-eslint/no-explicit-any */
// NOTE: This flow is intentionally light on typing because we support running
// under multiple MCP server implementations (with or without the official SDK).

import type { PaidWrapperFactory, ToolHandler } from "../types/flows.js";
import type { McpServerLike } from "../types/mcp.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { PriceConfig, ToolExtraLike } from "../types/config.js";
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

import { z } from "zod";

// Simple in‑memory arg storage. Keyed by paymentId string.
const PENDING_ARGS = new Map<
  string,
  {
    // args passed to the original tool (normalized params object or undefined)
    args: any;
    // unix ms timestamp when the initiate step ran
    ts: number;
  }
>();

/**
 * Safely invoke the original tool handler preserving the (args, extra) vs (extra)
 * call shapes used by the MCP TS SDK.
 */
async function callOriginal(
  func: ToolHandler,
  toolArgs: any | undefined,
  extra: any
) {
  if (toolArgs !== undefined) {
    return await func(toolArgs, extra);
  } else {
    return await func(extra);
  }
}

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

  log?.debug?.(`[PayMCP:TwoStep] ensureConfirmTool(${confirmToolName})`);

  // Detect if already registered (server API shape may vary; we duck‑type).
  const srvAny = server as any;
  const toolsMap: Map<
    string,
    { config: any; handler: ToolHandler }
  > | undefined = srvAny?.tools;
  if (toolsMap?.has(confirmToolName)) {
    log?.debug?.(`[PayMCP:TwoStep] confirm tool already registered.`);
    return confirmToolName;
  }

  // Minimal param schema (Zod) for confirmation tool.
  // Using Zod avoids keyValidator/_parse errors seen when passing plain JSON object.
  const inputSchema = {
    payment_id: z.string(),
  };

  // Confirmation handler: verify payment, retrieve saved args, invoke original tool.
  const confirmHandler: ToolHandler = async (
    paramsOrExtra: any,
    maybeExtra?: any
  ) => {
    const hasArgs = arguments.length === 2;
    const params = hasArgs ? paramsOrExtra : undefined;
    const extra = hasArgs ? maybeExtra : paramsOrExtra;

    log?.info?.(`[PayMCP:TwoStep] confirm handler invoked for ${toolName}`);

    const paymentId: string | undefined = hasArgs
      ? (params as any)?.payment_id
      : (extra as any)?.payment_id; // defensive fallback

    log?.debug?.(`[PayMCP:TwoStep] confirm received payment_id=${paymentId}`);

    if (!paymentId) {
      return {
        content: [{ type: "text", text: "Missing payment_id." }],
        status: "error",
        message: "Missing payment_id",
      };
    }

    // Try to retrieve args from state store first
    let stored: { args: any; ts: number } | undefined;
    let sessionId: string | undefined;

    if (stateStore) {
      // Try to get state from store using payment_id as key
      const state = await stateStore.get(paymentId);
      if (state) {
        stored = {
          args: state.tool_args?.params,
          ts: state.created_at || Date.now()
        };
        sessionId = state.session_id;
        log?.debug?.(`[PayMCP:TwoStep] Retrieved args from state store using payment_id`);
      }
    }

    // Fall back to legacy PENDING_ARGS if not found in state store
    if (!stored) {
      stored = PENDING_ARGS.get(String(paymentId));
      log?.debug?.(`[PayMCP:TwoStep] Retrieved args from legacy PENDING_ARGS`);
    }

    log?.debug?.(`[PayMCP:TwoStep] PENDING_ARGS keys=${Array.from(PENDING_ARGS.keys()).join(",")}`);

    if (!stored) {
      return {
        content: [{ type: "text", text: "Unknown or expired payment_id." }],
        status: "error",
        message: "Unknown or expired payment_id",
        payment_id: paymentId,
      };
    }

    // Check provider status.
    let status: string;
    try {
      status = await provider.getPaymentStatus(paymentId);
      log?.debug?.(`[PayMCP:TwoStep] provider.getPaymentStatus(${paymentId}) -> ${status}`);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to check payment status: ${(err as Error).message}`,
          },
        ],
        status: "error",
        message: "Failed to check payment status",
        payment_id: paymentId,
      };
    }

    const statusLc = String(status).toLowerCase();
    if (statusLc !== "paid") {
      return {
        content: [
          {
            type: "text",
            text: `Payment status is ${status}, expected 'paid'.`,
          },
        ],
        status: "error",
        message: `Payment status is ${status}, expected 'paid'`,
        payment_id: paymentId,
      };
    }

    // We're good—consume stored args and call original.
    PENDING_ARGS.delete(String(paymentId));

    // Clean up state using utility
    await cleanupPaymentState(paymentId, stateStore, log);
    if (sessionId && sessionId !== paymentId) {
      await cleanupPaymentState(sessionId, stateStore, log);
    }

    log?.info?.(`[PayMCP:TwoStep] payment confirmed; calling original tool ${toolName}`);
    const toolResult = await callOriginal(
      originalHandler,
      stored.args,
      extra /* pass confirm extra */
    );
    // If toolResult missing content, synthesize one.
    if (!toolResult || !Array.isArray((toolResult as any).content)) {
      return {
        content: [
          { type: "text", text: "Tool completed after confirmed payment." },
        ],
        raw: toolResult,
      };
    }
    return toolResult;
  };

  // Register the confirm tool (no price, so PayMCP will not wrap it again).
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

export const makePaidWrapper: PaidWrapperFactory = (
  func,
  server: McpServerLike,
  provider: BasePaymentProvider,
  priceInfo: PriceConfig,
  toolName: string,
  logger?: Logger,
  stateStore?: StateStoreProvider
) => {
  const log: Logger = logger ?? (provider as any).logger ?? console;

  // Eagerly register confirm tool so the client sees it in the initial tool list.
  // (Matches Python behaviour where @mcp.tool registers at import time.)
  const confirmToolName = ensureConfirmTool(
    server,
    provider,
    toolName,
    func,
    log,
    stateStore
  );

  async function twoStepWrapper(paramsOrExtra: any, maybeExtra?: any) {
    const hasArgs = arguments.length === 2;
    const toolArgs = hasArgs ? paramsOrExtra : undefined;
    const extra: ToolExtraLike = hasArgs ? maybeExtra : paramsOrExtra;

    log?.debug?.(`[PayMCP:TwoStep] initiate wrapper invoked for ${toolName}, hasArgs=${hasArgs}`);

    // Extract session ID from extra context using utility
    const sessionId = extractSessionId(extra, log);

    // Check for existing payment state using utility
    const checkResult = await checkExistingPayment(
      sessionId, stateStore, provider, toolName, { params: toolArgs }, log
    );

    // If payment was already completed, execute immediately
    if (checkResult.shouldExecuteImmediately) {
      const argsToUse = checkResult.storedArgs?.params || toolArgs;
      return await callOriginal(func, argsToUse, extra);
    }

    // If payment exists but is still pending, return existing payment info
    if (checkResult.paymentId && checkResult.paymentUrl) {
      const paymentId = checkResult.paymentId;
      const paymentUrl = checkResult.paymentUrl;

      const _message = paymentPromptMessage(
        paymentUrl,
        priceInfo.amount,
        priceInfo.currency
      );

      const message = JSON.stringify({
        "message": `Payment still pending: ${_message}`,
        "payment_url": paymentUrl,
        "payment_id": paymentId,
        "next_step": confirmToolName
      });

      return {
        content: [{ type: "text", text: message }],
        structured_content: {
          payment_url: paymentUrl,
          payment_id: paymentId,
          next_step: confirmToolName,
          status: "payment_pending",
          amount: priceInfo.amount,
          currency: priceInfo.currency,
        },
        data: {
          payment_url: paymentUrl,
          payment_id: paymentId,
          next_step: confirmToolName,
          status: "payment_pending",
          amount: priceInfo.amount,
          currency: priceInfo.currency,
        },
        message,
      };
    }

    // Create payment.
    const { paymentId, paymentUrl } = await provider.createPayment(
      priceInfo.amount,
      priceInfo.currency,
      `${toolName}() execution fee`
    );

    const pidStr = String(paymentId);

    // Store payment state using utility
    await savePaymentState(
      sessionId, stateStore, paymentId, paymentUrl,
      toolName, { params: toolArgs }, 'requested', log
    );

    // Also store by payment_id for backward compatibility with two-step flow
    if (stateStore && sessionId && sessionId !== pidStr) {
      await stateStore.put(pidStr, {
        session_id: sessionId,
        payment_id: paymentId,
        payment_url: paymentUrl,
        tool_name: toolName,
        tool_args: { params: toolArgs },
        status: 'requested',
        created_at: Date.now()
      });
    } else if (!stateStore) {
      // Fall back to legacy PENDING_ARGS
      PENDING_ARGS.set(pidStr, { args: toolArgs, ts: Date.now() });
    }

    // Build message shown to user / LLM.
    const _message = paymentPromptMessage(
      paymentUrl,
      priceInfo.amount,
      priceInfo.currency
    );

    const message = JSON.stringify({
      "message": _message,
      "payment_url": paymentUrl,
      "payment_id": paymentId,
      "next_step": confirmToolName
    })

    log?.info?.(`[PayMCP:TwoStep] payment initiated pid=${pidStr} url=${paymentUrl} next=${confirmToolName}`);

    // Return step‑1 response. Include content to satisfy MCP schemas.
    return {
      // Human-facing message (shown in most MCP UIs)
      content: [{ type: "text", text: message }],
      // Machine-friendly payload (FastMCP Python will expose this as `structured_content`)
      structured_content: {
        payment_url: paymentUrl,
        payment_id: pidStr,
        next_step: confirmToolName,
        status: "payment_required",
        amount: priceInfo.amount,
        currency: priceInfo.currency,
      },
      // Some clients also surface `data`; include for redundancy / future-proofing.
      data: {
        payment_url: paymentUrl,
        payment_id: pidStr,
        next_step: confirmToolName,
        status: "payment_required",
        amount: priceInfo.amount,
        currency: priceInfo.currency,
      },
      // Deprecated / backward-compat fields (kept for introspection; safe to remove later)
      message,
    };
  }

  return twoStepWrapper as unknown as ToolHandler;
};