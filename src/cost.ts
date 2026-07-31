// Recursive cheapest-source cost (§4): cost(item) = min(buy-on-TP, craft-it, coin-vendor, held stock).
// Leaves must be obtainable (TP-priced, coin-buyable, or held in sufficient quantity) or the branch is disqualified.
import type { Recipe } from "./gw2api.ts";
import type { TpData } from "./datawars.ts";
import { coinVendorPrice } from "./coinVendor.ts";
import { freeMatPrice } from "./freeMats.ts";

export interface CostModel {
  tp: Map<number, TpData>;
  // output item id -> recipes producing it
  craftMap: Map<number, Recipe[]>;
  // drop-only mats the account already holds (bank/material-storage scan) -> units on hand.
  ownedMats: Map<number, number>;
  // EVERYTHING the account holds (bank + material storage), tradable included -> units on hand.
  // Only consulted when `creditOwned` is set.
  heldMats: Map<number, number>;
  // Out-of-pocket mode (§5): a leaf already held in sufficient quantity costs 0 coin regardless
  // of its market price. This measures cash spent, NOT economic cost — a model with this set
  // must never feed craft_cost/roi_pct or the gates, only the net_* figures.
  creditOwned?: boolean;
}

// Ingredients acquired by instant-buy at seller's ask (sell_price).
function tpPrice(tp: Map<number, TpData>, id: number): number {
  const d = tp.get(id);
  if (!d) return 0;
  return d.sell_price;
}

// Cheapest per-unit cost to obtain `need` units of `itemId`, or null if that many cannot be
// obtained. TP and vendor supply is treated as unlimited, so `need` only constrains held stock.
export function costOf(
  model: CostModel,
  itemId: number,
  need: number,
  memo: Map<string, number | null> = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  const key = `${itemId}:${need}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // Out-of-pocket mode: stock already in the account is free to *acquire*, whatever it is worth.
  // Short-circuit — nothing beats 0, and skipping the craft recursion keeps this pass cheap.
  if (model.creditOwned && (model.heldMats.get(itemId) ?? 0) >= need) {
    memo.set(key, 0);
    return 0;
  }

  const candidates: number[] = [];

  const tpp = tpPrice(model.tp, itemId);
  if (tpp > 0) candidates.push(tpp);

  const coin = coinVendorPrice(itemId);
  if (coin !== undefined) candidates.push(coin);

  // Neither TP-buyable nor coin-buyable: the only supply is stock already in the account, and
  // that stock is finite. Requiring owned >= need is what keeps grind-gated mats (Ley Line
  // Spark, Pile of Auric Dust, Bottle of Airship Oil, Obsidian Shard) from being priced as an
  // unlimited 0c supply because a single unit happens to sit in the bank. Their flags are
  // identical to genuinely-free overflow mats (Bloodstone Dust), so quantity is the only
  // signal that separates the two.
  // Owning a TP-tradable mat does NOT make it free — it has a real resale value. Pricing
  // owned-but-tradable mats at 0 (e.g. NoSell-flagged mats like Pristine Toxic Spore Sample,
  // which is fully TP-traded) massively inflates ROI.
  if (tpp === 0 && coin === undefined) {
    const owned = model.ownedMats.get(itemId) ?? 0;
    // freeMatPrice covers the curated bulk mats (data/free-mats.json); default 0 otherwise.
    if (owned >= need) candidates.push(freeMatPrice(itemId) ?? 0);
  }

  // craft-it: only follow acyclic recipe branches
  if (!visited.has(itemId)) {
    const recipes = model.craftMap.get(itemId);
    if (recipes) {
      visited.add(itemId);
      for (const r of recipes) {
        const c = craftCost(model, r, need, memo, visited);
        if (c !== null) candidates.push(c);
      }
      visited.delete(itemId);
    }
  }

  const result = candidates.length ? Math.min(...candidates) : null;
  memo.set(key, result);
  return result;
}

// Per-single-output copper cost of executing recipe `r` enough times to yield `need` outputs.
// null if any ingredient can't be obtained in the quantity those crafts consume.
export function craftCost(
  model: CostModel,
  r: Recipe,
  need: number = 1,
  memo: Map<string, number | null> = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  const count = r.output_item_count > 0 ? r.output_item_count : 1;
  const crafts = Math.ceil(need / count);
  let total = 0;
  for (const ing of r.ingredients) {
    const c = costOf(model, ing.item_id, ing.count * crafts, memo, visited);
    if (c === null) return null; // bad leaf -> whole craft disqualified
    total += c * ing.count;
  }
  return total / count;
}
