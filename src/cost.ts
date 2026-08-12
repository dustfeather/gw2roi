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
  // Read only by the out-of-pocket pass, which copies it before spending against it.
  heldMats: Map<number, number>;
}

// Where a node's cheapest supply came from. The market pass records this, not just the number,
// so the out-of-pocket pass can re-walk the SAME plan instead of re-deriving its own — which is
// what keeps the two figures comparable (§5).
export type Source =
  | { kind: "tp" | "vendor" | "drop"; unit: number }
  | { kind: "craft"; unit: number; recipe: Recipe };

export type CostMemo = Map<string, Source | null>;

// Ingredients acquired by instant-buy at seller's ask (sell_price).
function tpPrice(tp: Map<number, TpData>, id: number): number {
  const d = tp.get(id);
  if (!d) return 0;
  return d.sell_price;
}

// Cheapest supply for `need` units of `itemId`, or null if that many cannot be obtained.
// TP and vendor supply is treated as unlimited, so `need` only constrains held stock.
function bestSource(
  model: CostModel,
  itemId: number,
  need: number,
  memo: CostMemo,
  visited: Set<number>,
): Source | null {
  const key = `${itemId}:${need}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const candidates: Source[] = [];

  const tpp = tpPrice(model.tp, itemId);
  if (tpp > 0) candidates.push({ kind: "tp", unit: tpp });

  const coin = coinVendorPrice(itemId);
  if (coin !== undefined) candidates.push({ kind: "vendor", unit: coin });

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
    if (owned >= need) candidates.push({ kind: "drop", unit: freeMatPrice(itemId) ?? 0 });
  }

  // craft-it: only follow acyclic recipe branches
  if (!visited.has(itemId)) {
    const recipes = model.craftMap.get(itemId);
    if (recipes) {
      visited.add(itemId);
      for (const r of recipes) {
        const c = craftCost(model, r, need, memo, visited);
        if (c !== null) candidates.push({ kind: "craft", unit: c, recipe: r });
      }
      visited.delete(itemId);
    }
  }

  let best: Source | null = null;
  for (const c of candidates) if (best === null || c.unit < best.unit) best = c;
  memo.set(key, best);
  return best;
}

// Cheapest per-unit cost to obtain `need` units of `itemId`, or null if that many cannot be
// obtained.
export function costOf(
  model: CostModel,
  itemId: number,
  need: number,
  memo: CostMemo = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  return bestSource(model, itemId, need, memo, visited)?.unit ?? null;
}

// Per-single-output copper cost of executing recipe `r` enough times to yield `need` outputs.
// null if any ingredient can't be obtained in the quantity those crafts consume.
export function craftCost(
  model: CostModel,
  r: Recipe,
  need: number = 1,
  memo: CostMemo = new Map(),
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

// Out-of-pocket (§5): cash actually spent to execute `r` once, given what the account already
// holds. Follows the plan the market pass chose and pays market price only for what inventory
// cannot cover.
//
// The inventory is a COPY, spent down as the walk consumes it. That decrement is the whole
// point: `heldMats.get(id) >= need` evaluated independently per node let one stack pay for
// several branches at once — a tree needing 11 Glob of Ectoplasm across three sub-crafts
// priced all 11 at zero off 9 in the bank, because no single node ever asked for more than 5.
// Since net_profit is the board's rank key, that inflation reordered the board, and it grew
// with tree depth, so it favoured exactly the deep ascended chains it was least true for.
//
// Credit is also PARTIAL now: owning 1 of 3 Bolt of Damask pays for two, where the old
// all-or-nothing test charged full price for all three.
export function outOfPocketCost(
  model: CostModel,
  r: Recipe,
  need: number = 1,
  memo: CostMemo = new Map(),
  visited: Set<number> = new Set(),
): number | null {
  const inventory = new Map(model.heldMats);
  const count = r.output_item_count > 0 ? r.output_item_count : 1;
  const crafts = Math.ceil(need / count);
  let total = 0;
  for (const ing of r.ingredients) {
    const c = spend(model, ing.item_id, ing.count * crafts, inventory, memo, visited);
    if (c === null) return null;
    total += c;
  }
  // `total` is cash for `crafts` batches, i.e. crafts*count outputs. Amortize to one output,
  // the same way craftCost divides a single batch by `count`, so the two stay comparable.
  return total / (crafts * count);
}

// Total copper to put `qty` units of `itemId` in hand, spending `inventory` first.
// Returns null if the plan has no obtainable source, mirroring costOf.
function spend(
  model: CostModel,
  itemId: number,
  qty: number,
  inventory: Map<number, number>,
  memo: CostMemo,
  visited: Set<number>,
): number | null {
  const onHand = inventory.get(itemId) ?? 0;
  const used = Math.min(onHand, qty);
  if (used > 0) inventory.set(itemId, onHand - used);
  const remaining = qty - used;
  if (remaining === 0) return 0;

  const src = bestSource(model, itemId, remaining, memo, visited);
  if (src === null) return null;
  if (src.kind !== "craft") return src.unit * remaining;

  // Crafting the shortfall: only the units inventory could not cover.
  const r = src.recipe;
  const count = r.output_item_count > 0 ? r.output_item_count : 1;
  const crafts = Math.ceil(remaining / count);
  visited.add(itemId);
  let total = 0;
  for (const ing of r.ingredients) {
    const c = spend(model, ing.item_id, ing.count * crafts, inventory, memo, visited);
    if (c === null) {
      visited.delete(itemId);
      return null;
    }
    total += c;
  }
  visited.delete(itemId);
  return (total * remaining) / (crafts * count);
}
