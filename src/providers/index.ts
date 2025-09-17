import { WalleotProvider } from "./walleot.js";
import { StripeProvider } from "./stripe.js";
import { PayPalProvider } from "./paypal.js";
import type { BasePaymentProvider } from "./base.js";
import { type Logger } from "../types/logger.js";
import { AdyenProvider } from "./adyen.js";

/** Registry of known providers. */
const PROVIDER_MAP: Record<
  string,
  new (opts: { apiKey: string; logger?: Logger, successUrl?:string, sandbox?: boolean, merchantAccount?:string }) => BasePaymentProvider
> = {
  stripe: StripeProvider,
  walleot: WalleotProvider,
  paypal: PayPalProvider,  
  adyen: AdyenProvider
};

export type ProviderInstances = Record<string, BasePaymentProvider>;

/**
 * Converts an object of the form
 *   { "stripe": { apiKey: "..." }, "walleot": { apiKey: "..." } }
 * into { "stripe": StripeProviderInstance, "walleot": WalleotProviderInstance }.
 */
export function buildProviders(
  config: Record<string, { apiKey: string; successUrl?: string; cancelUrl?: string; merchantAccount?:string; logger?: Logger }>
): ProviderInstances {
  const instances: ProviderInstances = {};
  for (const [name, opts] of Object.entries(config)) {
    const cls = PROVIDER_MAP[name.toLowerCase()];
    if (!cls) {
      throw new Error(`[PayMCP] Unknown provider: ${name}`);
    }
    instances[name] = new cls(opts);
  }
  return instances;
}