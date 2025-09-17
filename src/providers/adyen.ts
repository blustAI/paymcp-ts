import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import {
  BasePaymentProvider,
} from "./base.js";

const ADYEN_API_TEST_URL = "https://checkout-test.adyen.com/v71";
const ADYEN_API_LIVE_URL = "https://checkout-live.adyen.com/v71";

export interface AdyenProviderOpts {
  apiKey: string;
  merchantAccount?: string;
  successUrl?: string;
  sandbox?: boolean;
  logger?: Logger;
}

export class AdyenProvider extends BasePaymentProvider {
  private merchantAccount: string;
  private returnUrl: string;
  private baseUrl: string;

  constructor(opts: AdyenProviderOpts) {
    super(opts.apiKey, opts.logger);
    this.merchantAccount = opts.merchantAccount as string;
    this.returnUrl = opts.successUrl ?? "https://example.com/return";
    this.baseUrl = opts.sandbox ? ADYEN_API_TEST_URL : ADYEN_API_LIVE_URL;
    this.logger?.debug("Adyen ready");
  }

  protected buildHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    this.logger?.debug(
      `Creating Adyen payment: ${amount} ${currency} for '${description}' (MERCHANT: ${this.merchantAccount})`
    );
    const data = {
      amount: {
        currency: currency.toUpperCase(),
        value: Math.round(amount * 100),
      },
      reference: description,
      merchantAccount: this.merchantAccount,
      returnUrl: this.returnUrl,
    };
    const payment = await this.request<any>(
      "POST",
      `${this.baseUrl}/paymentLinks`,
      data
    );
    if (!payment?.id || !payment?.url) {
      throw new Error("Adyen createPayment: missing id or url in response");
    }
    return {
      paymentId: payment.id,
      paymentUrl: payment.url,
    };
  }

  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger?.debug(`Checking Adyen payment status for: ${paymentId}`);
    const payment = await this.request<any>(
      "GET",
      `${this.baseUrl}/paymentLinks/${paymentId}`
    );
    const status = payment?.status;
    if (status === "completed") {
      return "paid";
    } else if (status === "active") {
      return "pending";
    } else if (status === "expired") {
      return "failed";
    }
    return status ?? "unknown";
  }
}