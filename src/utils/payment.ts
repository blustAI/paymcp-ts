// Normalize diverse provider status strings to canonical values used by PayMCP.
type CanonicalStatus = "paid" | "canceled" | "pending";
export function normalizeStatus(raw: unknown): CanonicalStatus {
  const s = String(raw ?? "").toLowerCase();
  if (["paid", "succeeded", "success", "complete", "completed", "ok", "no_payment_required"].includes(s)) {
    return "paid";
  }
  if (["canceled", "cancelled", "void", "failed", "declined", "error"].includes(s)) {
    return "canceled";
  }
  return "pending";
}