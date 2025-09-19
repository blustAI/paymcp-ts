import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import { BasePaymentProvider } from "./base.js";
import { PaymentStatus } from "../utils/constants.js";

const BASE_URL = "https://api.commerce.coinbase.com";

export interface CoinbaseProviderOpts {
  apiKey: string;
  successUrl?: string;
  cancelUrl?: string;
  /** If true — treat payment as successful already at PENDING status. */
  /** but there is a small chance something may still go wrong with the payment. */
  confirmOnPending?: boolean;
  logger?: Logger;
}

/**
 * Coinbase Commerce provider (Charges API).
 * Creates a charge and returns (code, hosted_url).
 */
export class CoinbaseProvider extends BasePaymentProvider {
  private successUrl: string;
  private cancelUrl: string;
  private confirmOnPending: boolean;

  constructor(opts: CoinbaseProviderOpts) {
    super(opts.apiKey, opts.logger);
    this.successUrl = opts.successUrl ?? "https://example.com/success";
    this.cancelUrl = opts.cancelUrl ?? "https://example.com/cancel";
    this.confirmOnPending = Boolean(opts.confirmOnPending);
    this.logger.debug("[CoinbaseProvider] ready");
  }

  /** Coinbase Commerce requires JSON and X-CC-Api-Key. */
  protected override buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "X-CC-Api-Key": this.apiKey,
      "Content-Type": "application/json",
    };
    return headers;
  }

  /**
   * Create a charge and get (paymentId=code, paymentUrl=hosted_url). Commerce expects local_price in fiat; if "USDC" is passed, force it to "USD".
   */
  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    const fiatCurrency = this.toFiatCurrency(currency);
    this.logger.debug(
      `[CoinbaseProvider] createPayment ${amount} ${currency} -> ${fiatCurrency} "${description}"`
    );

    const body = {
      name: (description || "Payment").slice(0, 100),
      description: description || "",
      pricing_type: "fixed_price",
      local_price: {
        amount: amount.toFixed(2), 
        currency: fiatCurrency,
      },
      redirect_url: this.successUrl,
      cancel_url: this.cancelUrl,
      metadata: { reference: description || "" },
    };

    const res = await this.request<any>("POST", `${BASE_URL}/charges`, body);
    const data = res?.data;
    if (!data?.code || !data?.hosted_url) {
      throw new Error(
        "[CoinbaseProvider] Invalid response from /charges (missing code/hosted_url)"
      );
    }
    return { paymentId: data.code, paymentUrl: data.hosted_url };
  }

  /**
   * Check status by charge.code. Take the last status from timeline and map to paid/pending/failed.
   */
  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger.debug(`[CoinbaseProvider] getPaymentStatus ${paymentId}`);
    const res = await this.request<any>("GET", `${BASE_URL}/charges/${paymentId}`);
    const data = res?.data ?? {};
    const timeline: Array<{ status?: string }> = data.timeline ?? [];
    const lastStatus = timeline.length ? String(timeline[timeline.length - 1].status) : undefined;

    // Compact mapping with support for confirmOnPending
    if (lastStatus === "COMPLETED" || lastStatus === "RESOLVED") return PaymentStatus.PAID;
    if (lastStatus === "PENDING") return this.confirmOnPending ? PaymentStatus.PAID : PaymentStatus.PENDING;
    if (lastStatus === "EXPIRED" || lastStatus === "CANCELED") return PaymentStatus.FAILED;

    // Fallback to completion fields
    if (data.completed_at || data.confirmed_at) return PaymentStatus.PAID;
    return PaymentStatus.PENDING;
  }

  /** Convert USDC → USD for local_price (Commerce expects fiat). */
  private toFiatCurrency(currency: string): string {
    const c = (currency || "USD").toUpperCase();
    return c === "USDC" ? "USD" : c;
  }
}