import { type Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";
import { BasePaymentProvider } from "./base.js";
import { PaymentStatus } from "../utils/constants.js";

const SANDBOX_URL = "https://connect.squareupsandbox.com";
const PRODUCTION_URL = "https://connect.squareup.com";

/**
 * Square Checkout provider.
 *
 * Creates Square Checkout payment links and tracks payment status.
 */
export interface SquareProviderOpts {
  accessToken: string;
  locationId: string;
  sandbox?: boolean;
  redirectUrl?: string;
  apiVersion?: string;  // Add API version option
  logger?: Logger;
}

/**
 * Standard provider options interface (for compatibility with provider map).
 */
export interface SquareStandardOpts {
  apiKey: string; // Expected format: "accessToken:locationId:sandbox"
  logger?: Logger;
}

interface SquarePaymentLinkResponse {
  payment_link: {
    id: string;
    url: string;
    version: number;
    order_id: string;
    created_at: string;
  };
  related_resources: {
    orders: Array<{
      id: string;
      location_id: string;
      state: string;
      total_money: {
        amount: number;
        currency: string;
      };
    }>;
  };
}

export class SquareProvider extends BasePaymentProvider {
  private accessToken: string;
  private locationId: string;
  private baseUrl: string;
  private redirectUrl: string;
  private apiVersion: string;

  constructor(opts: SquareStandardOpts | SquareProviderOpts) {
    let parsedOpts: SquareProviderOpts;

    // Handle standard provider interface (apiKey format)
    if ('apiKey' in opts) {
      const parts = opts.apiKey.split(':');
      if (parts.length < 3) {
        throw new Error('[SquareProvider] apiKey must be in format "accessToken:locationId:sandbox"');
      }

      parsedOpts = {
        accessToken: parts[0],
        locationId: parts[1],
        sandbox: parts[2] === 'sandbox',
        logger: opts.logger,
      };
    } else {
      // Handle Square-specific interface
      parsedOpts = opts;
    }

    // Square uses access token, but we pass empty string to base
    super("", parsedOpts.logger);

    this.accessToken = parsedOpts.accessToken;
    this.locationId = parsedOpts.locationId;
    this.baseUrl = parsedOpts.sandbox !== false ? SANDBOX_URL : PRODUCTION_URL;
    this.redirectUrl = parsedOpts.redirectUrl ?? "https://example.com/success";
    this.apiVersion = parsedOpts.apiVersion ?? process.env.SQUARE_API_VERSION ?? "2025-03-19";

    this.logger.debug(`[SquareProvider] ready - locationId: ${this.locationId}, apiVersion: ${this.apiVersion}`);
  }

  /**
   * Square uses Bearer token authentication.
   */
  protected override buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": this.apiVersion, // Use configurable API version
    };
  }

  /**
   * Override request to use JSON for Square.
   */
  protected override async request<T>(
    method: string,
    url: string,
    data?: any
  ): Promise<T> {
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
        `[SquareProvider] HTTP ${response.status}: ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create Square Payment Link using modern Payment Links API.
   * Uses quick_pay structure for simple payment collection.
   */
  async createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult> {
    const cents = this.toSquareAmount(amount);
    this.logger.debug(
      `[SquareProvider] createPayment ${amount} ${currency} (${cents}) "${description}"`
    );

    // Generate idempotency key for Square (required for payment creation)
    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    // Use Payment Links API with quick_pay structure
    const payload = {
      idempotency_key: idempotencyKey,
      quick_pay: {
        name: description,
        price_money: {
          amount: cents,
          currency: currency.toUpperCase(),
        },
        location_id: this.locationId,
      },
    };

    this.logger.debug(`[SquareProvider] Sending payload: ${JSON.stringify(payload, null, 2)}`);
    this.logger.debug(`[SquareProvider] Location ID in payload: ${this.locationId}`);

    const response = await this.request<SquarePaymentLinkResponse>(
      "POST",
      `${this.baseUrl}/v2/online-checkout/payment-links`,
      payload
    );

    if (!response?.payment_link?.id || !response?.payment_link?.url) {
      throw new Error(
        "[SquareProvider] Invalid response from Square Payment Links API"
      );
    }

    return {
      paymentId: response.payment_link.id,
      paymentUrl: response.payment_link.url
    };
  }

  /**
   * Get payment status by payment link ID.
   * For Payment Links, we check the associated order status.
   *
   * Square order states: OPEN, COMPLETED, CANCELED, DRAFT
   */
  async getPaymentStatus(paymentId: string): Promise<string> {
    this.logger.debug(`[SquareProvider] getPaymentStatus ${paymentId}`);

    try {
      // Get the payment link to find the order ID
      const paymentLinkResponse = await this.request<SquarePaymentLinkResponse>(
        "GET",
        `${this.baseUrl}/v2/online-checkout/payment-links/${paymentId}`
      );

      if (!paymentLinkResponse?.payment_link?.order_id) {
        return PaymentStatus.PENDING;
      }

      const orderId = paymentLinkResponse.payment_link.order_id;

      // Check the order status
      const orderResponse = await this.request<any>(
        "GET",
        `${this.baseUrl}/v2/orders/${orderId}?location_id=${this.locationId}`
      );

      // Check if order is fully paid by looking at net_amount_due
      const netAmountDue = orderResponse?.order?.net_amount_due_money?.amount ?? null;

      // If net amount due is 0, the order is fully paid
      if (netAmountDue === 0) {
        return PaymentStatus.PAID;
      }

      // Map Square order state to unified status
      switch (orderResponse?.order?.state) {
        case "COMPLETED":
          return PaymentStatus.PAID;
        case "CANCELED":
          return PaymentStatus.CANCELED;
        case "OPEN":
        case "DRAFT":
        default:
          return PaymentStatus.PENDING;
      }
    } catch (error) {
      this.logger.error(`[SquareProvider] Error checking status:`, error);
      // If we can't check status, assume it's still pending
      return PaymentStatus.PENDING;
    }
  }

  /**
   * Convert amount to Square's smallest currency unit (cents).
   * Square uses the smallest denomination of the currency (e.g., cents for USD).
   */
  private toSquareAmount(amount: number): number {
    // TODO: Handle zero-decimal currencies if needed
    return Math.round(amount * 100);
  }
}

/**
 * Factory function for creating Square provider.
 * Follows the same pattern as other providers.
 */
export function createSquareProvider(opts: SquareProviderOpts): SquareProvider {
  return new SquareProvider(opts);
}