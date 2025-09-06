import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import {
  BasePaymentProvider,
} from "./base.js";

const BASE_URL = "https://api-m.sandbox.paypal.com/v2";

/**
 * PayPal Payments provider.
 *
 * Creates a PayPal Order and returns (id, url)
 */
export interface PayPalProviderOpts {
  clientId: string;
  clientSecret: string;
  successUrl?: string;
  cancelUrl?: string;
  logger?: Logger;
}

export class PayPalProvider extends BasePaymentProvider {
  private successUrl: string;
  private cancelUrl: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private tokenExpiresAt?: number;

  constructor(opts: PayPalProviderOpts) {
    // Use client credentials for OAuth 2.0 authentication
    super("", opts.logger); // Will be replaced with actual token
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;

    this.successUrl =
      opts.successUrl ??
      "https://yoururl.com/success?token={token}";
    this.cancelUrl = opts.cancelUrl ?? "https://yoururl.com/cancel";
    this.logger?.debug("[PayPalProvider] ready");
  }

  /**
   * Get access token for API calls using client credentials flow.
   */
  private async getAccessToken(): Promise<string> {
    // Check if current token is still valid (with 5min buffer)
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt && (this.tokenExpiresAt - now > 5 * 60 * 1000)) {
      return this.accessToken;
    }

    // Fetch new token using client credentials
    if (!this.clientId || !this.clientSecret) {
      throw new Error("[PayPalProvider] Missing clientId or clientSecret for OAuth");
    }

    this.logger?.debug("[PayPalProvider] Fetching new access token");

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const tokenUrl = BASE_URL.replace('/v2', '/v1/oauth2/token');

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[PayPalProvider] Token fetch failed: ${response.status} ${error}`);
    }

    const tokenData = await response.json() as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = tokenData.access_token;
    this.tokenExpiresAt = now + (tokenData.expires_in * 1000);

    this.logger?.debug("[PayPalProvider] Access token refreshed");
    return this.accessToken;
  }

  /**
   * Override request method to handle automatic token refresh for client credentials.
   */
  protected override async request<T = any>(
    method: string,
    url: string,
    data?: any
  ): Promise<T> {
    const token = await this.getAccessToken();
    
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method: method.toUpperCase(), headers };

    if (method.toUpperCase() === "GET") {
      if (data && Object.keys(data).length) {
        const qs = new URLSearchParams(data).toString();
        url += (url.includes("?") ? "&" : "?") + qs;
      }
    } else {
      init.body = JSON.stringify(data ?? {});
    }

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      this.logger?.error(`[PayPalProvider] Network error ${method} ${url}`, err);
      throw err;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => 'Unable to read response body');
      this.logger?.error(
        `[PayPalProvider] HTTP ${resp.status} ${method} ${url}: ${body}`
      );
      throw new Error(`HTTP ${resp.status} ${url}`);
    }

    const json = (await resp.json().catch(() => ({}))) as T;
    this.logger?.debug(
      `[PayPalProvider] HTTP ${method} ${url} ->`,
      resp.status,
      json
    );
    return json;
  }

  /**
   * Create PayPal Order.
   *
   * Important parameters:
   * - intent=CAPTURE (one-time payment)
   * - return_url, cancel_url (mandatory redirects)
   * - amount[currency_code], amount[value] - order amount
   */
  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    if (!amount || amount <= 0) {
      throw new Error("[PayPalProvider] Invalid amount provided");
    }
    if (!currency || typeof currency !== 'string') {
      throw new Error("[PayPalProvider] Invalid currency provided");
    }
    if (!description || typeof description !== 'string') {
      throw new Error("[PayPalProvider] Invalid description provided");
    }
    
    const formattedAmount = this.toPayPalAmount(amount, currency);
    this.logger?.debug(
      `[PayPalProvider] createPayment ${amount} ${currency} (${formattedAmount}) "${description}"`
    );

    const data = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: currency.toUpperCase(),
            value: formattedAmount,
          },
          description: description,
        },
      ],
      application_context: {
        return_url: this.successUrl,
        cancel_url: this.cancelUrl,
      },
    };

    const order = await this.request<any>(
      "POST",
      `${BASE_URL}/checkout/orders`,
      data
    );

    if (!order?.id || !order?.links) {
      throw new Error(
        "[PayPalProvider] Invalid response from /checkout/orders (missing id/links)"
      );
    }

    const approvalLink = order.links.find((link: any) => link?.rel === "approve");
    if (!approvalLink?.href) {
      throw new Error(
        "[PayPalProvider] No approval link found in PayPal order response"
      );
    }

    return { paymentId: order.id, paymentUrl: approvalLink.href };
  }

  /**
   * Get payment status by order ID.
   * PayPal returns an Order object with a 'status' field (e.g., 'CREATED', 'APPROVED', 'COMPLETED').
   * If status is 'APPROVED', automatically captures the payment and returns the new status.
   */
  async getPaymentStatus(paymentId: string): Promise<string> {
    if (!paymentId || typeof paymentId !== 'string') {
      throw new Error("[PayPalProvider] Invalid paymentId provided");
    }
    
    this.logger?.debug(`[PayPalProvider] getPaymentStatus ${paymentId}`);
    const order = await this.request<any>(
      "GET",
      `${BASE_URL}/checkout/orders/${paymentId}`
    );
    
    const status = String(order?.status ?? "unknown");
    
    // Auto-capture if payment is approved
    if (status === "APPROVED") {
      try {
        this.logger?.debug(`[PayPalProvider] Auto-capturing approved payment ${paymentId}`);
        const captureResult = await this.capturePayment(paymentId);
        this.logger?.debug(`[PayPalProvider] Auto-capture successful for ${paymentId}, status: ${captureResult}`);
        return captureResult;
      } catch (error: any) {
        // Log warning but don't throw - return original approved status
        this.logger?.error(`[PayPalProvider] Auto-capture failed for ${paymentId}: ${error.message}`);
        return status;
      }
    }
    
    // Map PayPal status to PayMCP expected status
    if (status === "COMPLETED") {
      return "paid";
    }
    return status;
  }

  /**
   * Capture an approved PayPal payment.
   * Returns the captured payment status.
   */
  async capturePayment(paymentId: string): Promise<string> {
    if (!paymentId || typeof paymentId !== 'string') {
      throw new Error("[PayPalProvider] Invalid paymentId provided for capture");
    }
    
    this.logger?.debug(`[PayPalProvider] capturePayment ${paymentId}`);
    
    const captureResponse = await this.request<any>(
      "POST",
      `${BASE_URL}/checkout/orders/${paymentId}/capture`,
      {}
    );
    
    // Extract status from capture response
    const status = String(captureResponse?.status ?? "unknown");
    this.logger?.debug(`[PayPalProvider] Capture response status: ${status}`);
    
    // Map PayPal status to PayMCP expected status
    if (status === "COMPLETED") {
      return "paid";
    }
    return status;
  }

  /**
   * Convert amount to PayPal format.
   * PayPal expects amounts as strings with up to 2 decimal places.
   */
  private toPayPalAmount(amount: number, _currency: string): string {
    return amount.toFixed(2);
  }
}