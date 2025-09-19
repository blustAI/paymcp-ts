import type { PaymentFlow } from "../utils/constants.js";
import { type Logger } from "../types/logger.js";
import type { StateStoreProvider } from "../core/state-store.js";

export interface PriceConfig {
    amount: number;
    currency: string; // ISO 4217 (USD, EUR, etc.)
}

export interface PayToolConfig extends Record<string, any> {
    price?: PriceConfig;
    title?: string;
    description?: string;
    inputSchema?: unknown;
}

export interface PayMCPOptions {
    providers: Record<string, Record<string, any>>;
    paymentFlow?: PaymentFlow;
    retrofitExisting?: boolean;
    stateStore?: StateStoreProvider;
}

export interface ToolExtraLike {
    // Provided by Protocol to tool handlers. See Server.setRequestHandler in the TS SDK. citeturn5view0
    sendRequest?: (req: { method: string; params?: any }, resultSchema?: unknown) => Promise<any>;
    sendNotification?: (note: { method: string; params?: any }) => Promise<any>;
    sessionId?: string;
    requestId?: number | string;
    signal?: AbortSignal;
    reportProgress?: (args: { progress?: number; total?: number; message?: string; }) => Promise<void> | void;
}