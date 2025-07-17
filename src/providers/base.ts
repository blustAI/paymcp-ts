import { Logger } from "../types/logger.js";
import { type CreatePaymentResult } from "../types/payment.js";

export abstract class BasePaymentProvider {
  protected apiKey: string;
  protected logger: Logger;

  constructor(apiKey: string, logger?: Logger) {
    this.apiKey = apiKey;
    this.logger = logger ?? console;
  }

  /** Default headers (can be overridden). */
  protected buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  /**
   * Basic HTTP helper using fetch().
   * Can be replaced with axios if desired.
   */
  protected async request<T = any>(
    method: string,
    url: string,
    data?: any
  ): Promise<T> {
    const headers = this.buildHeaders();
    const init: RequestInit = { method: method.toUpperCase(), headers };

    if (method.toUpperCase() === "GET") {
      // Simple implementation: query string
      if (data && Object.keys(data).length) {
        const qs = new URLSearchParams(data).toString();
        url += (url.includes("?") ? "&" : "?") + qs;
      }
    } else {
      if (headers["Content-Type"] === "application/json") {
        init.body = JSON.stringify(data ?? {});
      } else {
        init.body = new URLSearchParams(
          Object.fromEntries(
            Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])
          )
        );
      }
    }

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      this.logger.error(`[BasePaymentProvider] Network error ${method} ${url}`, err);
      throw err;
    }

    if (!resp.ok) {
      const body = await resp.text();
      this.logger.error(
        `[BasePaymentProvider] HTTP ${resp.status} ${method} ${url}: ${body}`
      );
      throw new Error(`HTTP ${resp.status} ${url}`);
    }

    const json = (await resp.json()) as T;
    this.logger.debug(
      `[BasePaymentProvider] HTTP ${method} ${url} ->`,
      resp.status,
      json
    );
    return json;
  }

  /** Create payment. Return (id, url). */
  abstract createPayment(
    amount: number,
    currency: string,
    description: string
  ): Promise<CreatePaymentResult>;

  /** Check status. */
  abstract getPaymentStatus(paymentId: string): Promise<string>;
}