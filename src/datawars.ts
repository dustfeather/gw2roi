// datawars2 TP data: current prices + rolling velocity/quantity. No auth, no bot protection, bulk ids.
import { config } from "./config.ts";

const FIELDS = [
  "id",
  "buy_price",
  "sell_price",
  "buy_quantity",
  "sell_quantity",
  "1d_sell_sold", // units sold to buy orders over last day = sell-side demand velocity
  "1d_buy_sold",
] as const;

const CHUNK = 500;

export interface TpData {
  id: number;
  buy_price: number;
  sell_price: number;
  buy_quantity: number;
  sell_quantity: number;
  sell_sold_1d: number;
  buy_sold_1d: number;
}

interface RawRow {
  id: number;
  buy_price: number | null;
  sell_price: number | null;
  buy_quantity: number | null;
  sell_quantity: number | null;
  "1d_sell_sold": number | null;
  "1d_buy_sold": number | null;
}

function normalize(r: RawRow): TpData {
  return {
    id: r.id,
    buy_price: r.buy_price ?? 0,
    sell_price: r.sell_price ?? 0,
    buy_quantity: r.buy_quantity ?? 0,
    sell_quantity: r.sell_quantity ?? 0,
    sell_sold_1d: r["1d_sell_sold"] ?? 0,
    buy_sold_1d: r["1d_buy_sold"] ?? 0,
  };
}

// Fetch TP data for every id, chunked. Returns a lookup by item id.
export async function fetchTpData(ids: number[]): Promise<Map<number, TpData>> {
  const map = new Map<number, TpData>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const url =
      `${config.datawarsBase}/gw2/v1/items/json` +
      `?fields=${FIELDS.join(",")}&ids=${chunk.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`datawars ${res.status} ${res.statusText}`);
    const rows = (await res.json()) as RawRow[];
    for (const r of rows) map.set(r.id, normalize(r));
  }
  return map;
}
