// Recursive cheapest-source cost (§4): cost(item) = min(buy-on-TP, craft-it, coin-vendor, free-mat).
// Leaves must be obtainable (TP-priced, coin-buyable, or a free account-bound mat) or the branch is disqualified.
import type { Recipe } from "./gw2api.ts";
import type { TpData } from "./datawars.ts";
import { coinVendorPrice } from "./coinVendor.ts";
import { freeMatPrice } from "./freeMats.ts";

export interface CostModel {
  tp: Map<number, TpData>;
  // output item id -> recipes (from the craftable-now set) that produce it
  craftMap: Map<number, Recipe[]>;
  // drop-only mats the account already holds (bank/material-storage scan) -> priced as free.
  freeMatIds: Set<number>;
}

// Ingredients acquired by instant-buy at seller's ask (sell_price).
function tpPrice(tp: Map<number, TpData>, id: number): number {
  const d = tp.get(id);
  if (!d) return 0;
  return d.sell_price;
}

// Cheapest per-unit copper cost to obtain `itemId`, or null if unobtainable.
export function costOf(
  model: CostModel,
  itemId: number,
  memo: Map<number, number | null> = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  const cached = memo.get(itemId);
  if (cached !== undefined) return cached;

  const candidates: number[] = [];

  const tpp = tpPrice(model.tp, itemId);
  if (tpp > 0) candidates.push(tpp);

  const coin = coinVendorPrice(itemId);
  if (coin !== undefined) candidates.push(coin);

  // Account-bound bulk mats: can't be TP-bought or crafted, but accumulate for free.
  const free = freeMatPrice(itemId);
  if (free !== undefined) candidates.push(free);

  // Drop-only mats the account already owns (scanned from bank/material storage): free.
  if (model.freeMatIds.has(itemId)) candidates.push(0);

  // craft-it: only follow acyclic recipe branches
  if (!visited.has(itemId)) {
    const recipes = model.craftMap.get(itemId);
    if (recipes) {
      visited.add(itemId);
      for (const r of recipes) {
        const c = craftCost(model, r, memo, visited);
        if (c !== null) candidates.push(c);
      }
      visited.delete(itemId);
    }
  }

  const result = candidates.length ? Math.min(...candidates) : null;
  memo.set(itemId, result);
  return result;
}

// Per-single-output copper cost of executing recipe `r`. null if any ingredient unobtainable.
export function craftCost(
  model: CostModel,
  r: Recipe,
  memo: Map<number, number | null> = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  let total = 0;
  for (const ing of r.ingredients) {
    const c = costOf(model, ing.item_id, memo, visited);
    if (c === null) return null; // bad leaf -> whole craft disqualified
    total += c * ing.count;
  }
  const count = r.output_item_count > 0 ? r.output_item_count : 1;
  return total / count;
}
