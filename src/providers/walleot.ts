import { Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import { BasePaymentProvider } from "./base.js";
import pkg from '../../package.json' with { type: 'json' };

const BASE_URL = "https://api.walleot.com/v1";

export class WalleotProvider extends BasePaymentProvider {
  constructor(opts: { apiKey: string; logger?: Logger }) {
    super(opts.apiKey, opts.logger);
    this.logger.debug(`[WalleotProvider] ready v${pkg.version}`);
  }

  protected override buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    this.logger.debug(
      `[WalleotProvider] createPayment ${amount} ${currency} "${description}"`
    );
    const payload = {
      amount: Math.round(amount * 100), // amount in cents
      currency: currency.toLowerCase(),
      description,
    };
    const session = await this.request<any>(
      "POST",
      `${BASE_URL}/sessions`,
      payload
    );
    // API expected: { sessionId, url, ... }
    if (!session?.sessionId || !session?.url) {
      throw new Error(
        "[WalleotProvider] Invalid response from /sessions (missing sessionId/url)"
      );
    }
    return { paymentId: session.sessionId, paymentUrl: session.url };
  }

  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger.debug(`[WalleotProvider] getPaymentStatus ${paymentId}`);
    const session = await this.request<any>(
      "GET",
      `${BASE_URL}/sessions/${paymentId}`
    );
    // API expected: { status }
    return String(session?.status ?? "unknown").toLowerCase();
  }
}