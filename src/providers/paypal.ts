import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import { BasePaymentProvider } from "./base.js";

const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const PRODUCTION_URL = "https://api-m.paypal.com";

/**
 * PayPal Checkout provider.
 *
 * Creates PayPal Orders (intent=CAPTURE) and handles auto-capture on approval.
 */
export interface PayPalProviderOpts {
  clientId: string;
  clientSecret: string;
  sandbox?: boolean;
  successUrl?: string;
  cancelUrl?: string;
  logger?: Logger;
}

/**
 * Standard provider options interface (for compatibility with provider map).
 */
export interface PayPalStandardOpts {
  apiKey: string; // Expected format: "clientId:clientSecret" or "clientId:clientSecret:sandbox"
  logger?: Logger;
}

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

export class PayPalProvider extends BasePaymentProvider {
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private successUrl: string;
  private cancelUrl: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(opts: PayPalStandardOpts | PayPalProviderOpts) {
    let parsedOpts: PayPalProviderOpts;

    // Handle standard provider interface (apiKey format)
    if ('apiKey' in opts) {
      const parts = opts.apiKey.split(':');
      if (parts.length < 2) {
        throw new Error('[PayPalProvider] apiKey must be in format "clientId:clientSecret" or "clientId:clientSecret:sandbox"');
      }

      parsedOpts = {
        clientId: parts[0],
        clientSecret: parts[1],
        sandbox: parts[2] === 'sandbox',
        logger: opts.logger,
      };
    } else {
      // Handle PayPal-specific interface
      parsedOpts = opts;
    }

    // PayPal doesn't use a simple API key, but we pass empty string to base
    super("", parsedOpts.logger);

    this.clientId = parsedOpts.clientId;
    this.clientSecret = parsedOpts.clientSecret;
    this.baseUrl = parsedOpts.sandbox !== false ? SANDBOX_URL : PRODUCTION_URL;
    this.successUrl = parsedOpts.successUrl ?? "https://example.com/success";
    this.cancelUrl = parsedOpts.cancelUrl ?? "https://example.com/cancel";

    this.logger.debug("[PayPalProvider] ready");
  }

  /**
   * PayPal uses Bearer token authentication (OAuth 2.0).
   * We override to provide the access token instead of API key.
   * Note: This is synchronous to match base class, token fetching is handled in request method.
   */
  protected override buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken || ""}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Get OAuth 2.0 access token from PayPal.
   * Caches token until 5 minutes before expiry.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    this.logger.debug("[PayPalProvider] Fetching new access token");

    const auth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`
    ).toString("base64");

    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      throw new Error(
        `[PayPalProvider] Failed to get access token: ${response.status}`
      );
    }

    const data = (await response.json()) as PayPalTokenResponse;
    this.accessToken = data.access_token;
    // Cache with 5-minute buffer before expiry
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

    return this.accessToken;
  }

  /**
   * Override request to ensure we have a valid token and use JSON for PayPal.
   */
  protected override async request<T>(
    method: string,
    url: string,
    data?: any
  ): Promise<T> {
    // Ensure we have a valid access token before making the request
    await this.getAccessToken();

    const headers = this.buildHeaders();

    const options: RequestInit = {
      method,
      headers,
    };

    if (data && method !== "GET") {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[PayPalProvider] HTTP ${response.status}: ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create PayPal Order.
   * 
   * Important parameters:
   * - intent=CAPTURE for immediate payment capture after approval
   * - purchase_units with amount and description
   * - application_context with return URLs and user_action=PAY_NOW
   */
  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    this.logger.debug(
      `[PayPalProvider] createPayment ${amount} ${currency} "${description}"`
    );

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: currency.toUpperCase(),
            value: amount.toFixed(2),
          },
          description,
        },
      ],
      application_context: {
        return_url: this.successUrl,
        cancel_url: this.cancelUrl,
        user_action: "PAY_NOW", // Shows "Pay Now" instead of "Continue"
      },
    };

    const order = await this.request<PayPalOrderResponse>(
      "POST",
      `${this.baseUrl}/v2/checkout/orders`,
      payload
    );

    const approveLink = order.links?.find((link) => link.rel === "approve");
    
    if (!approveLink?.href) {
      throw new Error(
        "[PayPalProvider] No approval URL in PayPal response"
      );
    }

    return { paymentId: order.id, paymentUrl: approveLink.href };
  }

  /**
   * Get payment status by order ID.
   * Auto-captures APPROVED payments to complete the flow.
   * PayPal statuses: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED
   */
  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger.debug(`[PayPalProvider] getPaymentStatus ${paymentId}`);

    const order = await this.request<PayPalOrderResponse>(
      "GET",
      `${this.baseUrl}/v2/checkout/orders/${paymentId}`
    );

    // Auto-capture approved payments
    if (order.status === "APPROVED") {
      this.logger.debug(`[PayPalProvider] Auto-capturing payment ${paymentId}`);
      
      try {
        const captureResponse = await this.request<PayPalOrderResponse>(
          "POST",
          `${this.baseUrl}/v2/checkout/orders/${paymentId}/capture`,
          {}
        );
        
        return captureResponse.status === "COMPLETED" ? "paid" : "pending";
      } catch (error) {
        this.logger.error(
          `[PayPalProvider] Failed to capture ${paymentId}:`,
          error
        );
        return "pending";
      }
    }

    // Map PayPal status to unified status
    switch (order.status) {
      case "COMPLETED":
        return "paid";
      case "VOIDED":
      case "EXPIRED":
        return "canceled";
      default:
        return "pending";
    }
  }
}

/**
 * Factory function for creating PayPal provider.
 * Follows the same pattern as Stripe and Walleot providers.
 */
export function createPayPalProvider(opts: PayPalProviderOpts): PayPalProvider {
  return new PayPalProvider(opts);
}