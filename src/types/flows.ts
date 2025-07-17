// lib/ts/paymcp/src/flows/types.ts
import type { PriceConfig } from "./config.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { McpServerLike } from "./mcp.js";
import { Logger } from "./logger.js";


export type ToolHandler = (...args: any[]) => Promise<any> | any;


export type PaidWrapperFactory = (
  func: ToolHandler,
  server: McpServerLike,
  provider: BasePaymentProvider,
  priceInfo: PriceConfig,
  toolName: string,
  logger?: Logger
) => ToolHandler;


export type FlowModule = {
  makePaidWrapper: PaidWrapperFactory;
};