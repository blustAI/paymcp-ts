/**
 * Payment status normalization utilities for TypeScript providers.
 *
 * This module handles the complexity of normalizing payment status strings
 * from different payment providers into a consistent format that PayMCP
 * can work with reliably.
 *
 * Why normalization is needed:
 * - Different providers use different status strings for the same concepts
 * - Some providers use variations ("cancelled" vs "canceled")
 * - API responses may include unexpected status values
 * - Case sensitivity varies between providers
 *
 * This ensures all TypeScript providers return consistent status values
 * that match the PaymentStatus constants used throughout the system.
 */

/**
 * Canonical payment status values that PayMCP recognizes.
 * These map to the PaymentStatus constants in constants.ts.
 */
type CanonicalStatus = "paid" | "canceled" | "pending";

/**
 * Normalize diverse provider status strings to canonical PayMCP values.
 *
 * This function takes any payment status value from a provider API and
 * converts it to one of the three canonical status values that PayMCP
 * understands. It handles common variations and edge cases.
 *
 * Status Mapping:
 * - "paid": Payment successfully completed
 *   - Maps from: paid, succeeded, success, complete, completed, ok, no_payment_required
 * - "canceled": Payment was canceled or failed
 *   - Maps from: canceled, cancelled, void, failed, declined, error
 * - "pending": Payment is still in progress (default for unknown statuses)
 *   - Maps from: pending, processing, created, requires_action, and any unrecognized values
 *
 * @param raw - The raw status value from a payment provider.
 *              Can be string, number, object, null, undefined, etc.
 *              Common types: string, object with status field.
 *
 * @returns One of the three canonical status values.
 *          Defaults to "pending" for any unrecognized input.
 *
 * @example
 * ```typescript
 * // Stripe responses
 * normalizeStatus("succeeded") // → "paid"
 * normalizeStatus("canceled") // → "canceled"
 * normalizeStatus("processing") // → "pending"
 *
 * // PayPal responses
 * normalizeStatus("COMPLETED") // → "paid"
 * normalizeStatus("CANCELLED") // → "canceled"
 * normalizeStatus("PENDING") // → "pending"
 *
 * // Edge cases
 * normalizeStatus(null) // → "pending"
 * normalizeStatus(undefined) // → "pending"
 * normalizeStatus("unknown_status") // → "pending"
 * ```
 */
export function normalizeStatus(raw: unknown): CanonicalStatus {
  // Convert any input to lowercase string for consistent comparison
  // Handle null, undefined, objects, numbers, etc.
  const s = String(raw ?? "").toLowerCase();

  // Successful payment statuses
  // Covers common success variations from major providers
  if (["paid", "succeeded", "success", "complete", "completed", "ok", "no_payment_required"].includes(s)) {
    return "paid";
  }

  // Failed or canceled payment statuses
  // Covers common failure variations from major providers
  if (["canceled", "cancelled", "void", "failed", "declined", "error"].includes(s)) {
    return "canceled";
  }

  // Default to pending for any unrecognized status
  // This includes: pending, processing, created, requires_action, etc.
  // Better to assume payment is still in progress than to fail incorrectly
  return "pending";
}