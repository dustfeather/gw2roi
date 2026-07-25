// datawars2 TP data: current prices + rolling velocity/quantity. No auth, no bot protection, bulk ids.
import { config, VELOCITY_WINDOW_DAYS } from "./config.ts";

// The velocity fields are windowed (`7d_sell_sold` etc). datawars2 returns the TOTAL
// units traded over the window, so divide by the window length to get a per-day rate.
const WINDOW = config.velocityWindow;
const WINDOW_DAYS = VELOCITY_WINDOW_DAYS[WINDOW];
const SELL_SOLD_FIELD = `${WINDOW}_sell_sold`;
const BUY_SOLD_FIELD = `${WINDOW}_buy_sold`;

const FIELDS = [
  "id",
  "buy_price",
  "sell_price",
  "buy_quantity",
  "sell_quantity",
  SELL_SOLD_FIELD, // units sold to buy orders over the window = sell-side demand
  BUY_SOLD_FIELD,
];

const CHUNK = 500;

export interface TpData {
  id: number;
  buy_price: number;
  sell_price: number;
  buy_quantity: number;
  sell_quantity: number;
  // Per-day averages over `config.velocityWindow`, NOT window totals.
  sell_sold_day: number;
  buy_sold_day: number;
}

interface RawRow {
  id: number;
  buy_price: number | null;
  sell_price: number | null;
  buy_quantity: number | null;
  sell_quantity: number | null;
  // Keys are window-dependent (`1d_sell_sold` … `7d_sell_sold`), so index them.
  [windowedField: string]: number | null;
}

function perDay(total: number | null | undefined): number {
  return (total ?? 0) / WINDOW_DAYS;
}

function normalize(r: RawRow): TpData {
  return {
    id: r.id,
    buy_price: r.buy_price ?? 0,
    sell_price: r.sell_price ?? 0,
    buy_quantity: r.buy_quantity ?? 0,
    sell_quantity: r.sell_quantity ?? 0,
    sell_sold_day: perDay(r[SELL_SOLD_FIELD]),
    buy_sold_day: perDay(r[BUY_SOLD_FIELD]),
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
