// lib/ts/paymcp/src/flows/types.ts
import type { PriceConfig } from "./config.js";
import type { BasePaymentProvider } from "../providers/base.js";
import type { McpServerLike } from "./mcp.js";
import type { StateStoreProvider } from "../core/state-store.js";
import { Logger } from "./logger.js";


export type ToolHandler = (...args: any[]) => Promise<any> | any;

export interface PaidWrapperOptions {
  func: ToolHandler;
  server: McpServerLike;
  provider: BasePaymentProvider;
  priceInfo: PriceConfig;
  toolName: string;
  logger?: Logger;
  stateStore?: StateStoreProvider;
}

export type PaidWrapperFactory = (options: PaidWrapperOptions) => ToolHandler;


export type FlowModule = {
  makePaidWrapper: PaidWrapperFactory;
};