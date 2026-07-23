// Bundled free-mat table: item id -> copper per unit (0 for account-bound bulk mats).
// These leaves cannot be TP-bought/sold or crafted, but accumulate for free from play.
import raw from "../data/free-mats.json" with { type: "json" };

const prices = new Map<number, number>();
for (const [id, copper] of Object.entries((raw as { prices: Record<string, number> }).prices)) {
  prices.set(Number(id), copper);
}

// Copper cost per single unit for a free account-bound mat, or undefined if not one.
export function freeMatPrice(itemId: number): number | undefined {
  return prices.get(itemId);
}
