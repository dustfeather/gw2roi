// Bundled coin-vendor mat table: item id -> copper per unit. Loaded in-memory, no network.
import raw from "../data/coin-vendor.json" with { type: "json" };

const prices = new Map<number, number>();
for (const [id, copper] of Object.entries((raw as { prices: Record<string, number> }).prices)) {
  prices.set(Number(id), copper);
}

// Coin cost per single unit, or undefined if not coin-buyable.
export function coinVendorPrice(itemId: number): number | undefined {
  return prices.get(itemId);
}
