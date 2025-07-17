import { PriceConfig } from "../types/config.js";

export function appendPriceToDescription(desc: string | undefined, price: PriceConfig): string {
    const base = (desc ?? "").trim();
    const cost = `.\nThis is a paid function:${price.amount} ${price.currency}.\nPayment will be requested during execution.`;
    return base ? `${base}. ${cost}` : cost;
}


/** Build a user-facing payment prompt message: "Pay at URL (AMOUNT CUR)". */
export function paymentPromptMessage(url: string, amount: number, currency: string): string {
    return `To continue, please pay ${amount} ${currency} at:\n${url}`;
}