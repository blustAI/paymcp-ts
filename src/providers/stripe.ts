import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import {
  BasePaymentProvider,
} from "./base.js";

const BASE_URL = "https://api.stripe.com/v1";

/**
 * Stripe Checkout provider.
 *
 * Creates a Checkout Session (mode=payment) with inline price_data and returns (id, url)
 */
export interface StripeProviderOpts {
  apiKey: string;
  successUrl?: string;
  cancelUrl?: string;
  logger?: Logger;
}

export class StripeProvider extends BasePaymentProvider {
  private successUrl: string;
  private cancelUrl: string;

  constructor(opts: StripeProviderOpts) {
    super(opts.apiKey, opts.logger);
    this.successUrl =
      opts.successUrl ??
      "https://yoururl.com/success?session_id={CHECKOUT_SESSION_ID}";
    this.cancelUrl = opts.cancelUrl ?? "https://yoururl.com/cancel";
    this.logger.debug("[StripeProvider] ready");
  }

  /**
   * Stripe expects a form-encoded body (we inherit from BasePaymentProvider with
   * application/x-www-form-urlencoded standard). 
   */
  protected override buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  /**
   * Create Checkout Session.
   *
   * Important parameters:
   * - mode=payment (one-time) or other depending on scenario; here it's payment.  [oai_citation:11‡Stripe Docs](https://docs.stripe.com/api/checkout/sessions/create) [oai_citation:12‡Stripe Docs](https://docs.stripe.com/payments/checkout/how-checkout-works)
   * - success_url, cancel_url (mandatory redirects).  [oai_citation:13‡Stripe Docs](https://docs.stripe.com/api/checkout/sessions/create) [oai_citation:14‡Stripe Docs](https://docs.stripe.com/payments/checkout/how-checkout-works)
   * - line_items[0][price_data][currency], [unit_amount], [product_data][name] — inline price.  [oai_citation:15‡Stripe Docs](https://docs.stripe.com/payments/checkout/migrating-prices) [oai_citation:16‡Stripe Docs](https://docs.stripe.com/api/checkout/sessions/create)
   */
  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    const cents = this.toStripeAmount(amount, currency);
    this.logger.debug(
      `[StripeProvider] createPayment ${amount} ${currency} (${cents}) "${description}"`
    );

    const data: Record<string, string | number> = {
      mode: "payment",
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      "line_items[0][price_data][currency]": currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": cents,
      "line_items[0][price_data][product_data][name]": description,
      "line_items[0][quantity]": 1,
    };

    const session = await this.request<any>(
      "POST",
      `${BASE_URL}/checkout/sessions`,
      data
    );

    if (!session?.id || !session?.url) {
      throw new Error(
        "[StripeProvider] Invalid response from /checkout/sessions (missing id/url)"
      );
    }
    return { paymentId: session.id, paymentUrl: session.url };
  }

  /**
   * Get payment status by session.id.
   * Stripe returns a Session object with a 'payment_status' field (e.g., 'paid', 'unpaid').  [oai_citation:17‡Stripe Docs](https://docs.stripe.com/api/checkout/sessions/retrieve) [oai_citation:18‡Stripe Docs](https://docs.stripe.com/payments/checkout/how-checkout-works)
   */
  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger.debug(`[StripeProvider] getPaymentStatus ${paymentId}`);
    const session = await this.request<any>(
      "GET",
      `${BASE_URL}/checkout/sessions/${paymentId}`
    );
    // Return as is; mapping to unified status can be done later.
    return String(session?.payment_status ?? "unknown");
  }

  /**
   * Convert amount to "smallest currency unit" as required by Stripe (unit_amount).
   * For many currencies it's amount * 100, but for "zero-decimal" currencies, a special map is needed (TODO).
   * Docs: unit_amount is passed in the smallest currency units / "cents".  [oai_citation:19‡Stripe Docs](https://docs.stripe.com/api/checkout/sessions/create) [oai_citation:20‡Stripe Docs](https://docs.stripe.com/payments/checkout/migrating-prices)
   */
  private toStripeAmount(amount: number, _currency: string): number {
    // TODO: zero-decimal currency handling
    return Math.round(amount * 100);
  }
}