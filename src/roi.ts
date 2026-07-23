// ROI ranking (§5) + gates (§6). All money in copper.
import type { Recipe } from "./gw2api.ts";
import type { TpData } from "./datawars.ts";
import { config } from "./config.ts";
import { type CostModel, craftCost } from "./cost.ts";

export interface RoiRow {
  recipe_id: number;
  output_item_id: number;
  output_item_name: string; // filled for the top-N only (pipeline), "" otherwise
  output_item_count: number;
  // "" for the known table; "DISCOVER" (free) or "BUY" (recipe sheet) for the learnable table.
  learn_method: string;
  // primary craft-and-list economics, per single output item
  // (instant-buy ingredients, list output)
  craft_cost: number; // per single output item
  list_revenue: number; // sell_price * keep, per single output item
  profit: number;
  roi_pct: number;
  // also-displayed rows
  instant_sell_revenue: number; // dump output to buy orders: buy_price * keep
  // liquidity / velocity (of the OUTPUT item)
  sell_price: number;
  buy_price: number;
  sell_quantity: number;
  sell_sold_1d: number;
  days_to_sell: number;
}

export interface Scored {
  row: RoiRow;
  passes: boolean;
}

// Build ROI figures for one candidate recipe. Returns null if ingredients unobtainable
// or the output has no TP data.
export function scoreRecipe(
  model: CostModel,
  r: Recipe,
  memoInstant: Map<number, number | null>,
): Scored | null {
  const out = model.tp.get(r.output_item_id);
  if (!out) return null;

  const cost = craftCost(model, r, memoInstant);
  if (cost === null || cost <= 0) return null; // bad leaf -> disqualified in cost model

  const outCount = r.output_item_count > 0 ? r.output_item_count : 1;
  const keep = config.tpKeepRatio;

  // All values are per single output item; craftCost() already returns per-item
  // cost (ingredient total / output_item_count), so no outCount scaling here.
  const craftCostPer = cost;
  const listRevenue = out.sell_price * keep;
  const profit = listRevenue - craftCostPer;
  const roiPct = (profit / craftCostPer) * 100;

  const daysToSell =
    out.sell_sold_1d > 0 ? out.sell_quantity / out.sell_sold_1d : Infinity;

  const row: RoiRow = {
    recipe_id: r.id,
    output_item_id: r.output_item_id,
    output_item_name: "", // resolved for the top-N in the pipeline
    output_item_count: outCount,
    learn_method: "", // set by the pipeline for learnable rows

    craft_cost: Math.round(craftCostPer),
    list_revenue: Math.round(listRevenue),
    profit: Math.round(profit),
    roi_pct: roiPct,
    instant_sell_revenue: Math.round(out.buy_price * keep),
    sell_price: out.sell_price,
    buy_price: out.buy_price,
    sell_quantity: out.sell_quantity,
    sell_sold_1d: out.sell_sold_1d,
    days_to_sell: Number.isFinite(daysToSell) ? Math.round(daysToSell * 100) / 100 : 9999,
  };

  const g = config.gates;
  const passes =
    out.sell_price > 0 && // output sellable
    out.sell_sold_1d >= g.minSellSold1d && // demand velocity
    daysToSell <= g.maxDaysToSell && // supply overhang
    roiPct >= g.minRoiPct && // ROI floor
    profit >= g.minProfitCopper; // profit floor

  return { row, passes };
}
