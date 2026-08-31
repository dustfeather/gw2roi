// Everything the board reads, in four queries. SSR keeps the D1 binding server-side: no token
// and no query ever reaches the client.
import {
  accountBalance,
  craftRoi,
  craftRoiLearnable,
  tpTransactions,
  type Db,
} from "@gw2/core";
import { asc, desc } from "drizzle-orm";

export type KnownRow = typeof craftRoi.$inferSelect;
export type LearnableRow = typeof craftRoiLearnable.$inferSelect;

// One point of the cumulative TP graph. Copper, converted to gold at render time.
// `balance` is null wherever there is no balance figure for that instant — the chart spans
// those gaps rather than dropping to zero.
export interface SeriesPoint {
  t: number; // epoch ms
  bought: number;
  sold: number;
  net: number;
  balance: number | null;
}

export interface BoardData {
  known: KnownRow[];
  learnable: LearnableRow[];
  updatedAt: Date | null;
  bestNetProfit: number | null;
  series: SeriesPoint[];
}

export async function loadBoard(db: Db): Promise<BoardData> {
  // Sorting happens in SQL on the raw integer. `net_profit` is the single rank key — the same
  // one pipeline.ts uses for top-N selection and the headline stat below. Selection and display
  // sharing a key is what stops top-N picking a different set than the board renders.
  const [known, learnable, balances, txns] = await Promise.all([
    db.select().from(craftRoi).orderBy(desc(craftRoi.net_profit)),
    db.select().from(craftRoiLearnable).orderBy(desc(craftRoiLearnable.net_profit)),
    db
      .select({ recorded_at: accountBalance.recorded_at, coin: accountBalance.coin })
      .from(accountBalance)
      .orderBy(asc(accountBalance.recorded_at)),
    db
      .select({
        purchased_at: tpTransactions.purchased_at,
        kind: tpTransactions.kind,
        price: tpTransactions.price,
        quantity: tpTransactions.quantity,
      })
      .from(tpTransactions)
      .orderBy(asc(tpTransactions.purchased_at)),
  ]);

  return {
    known,
    learnable,
    // Every row of a run shares one `updated_at` (the table is rewritten whole), so any row
    // answers "when did this board last change".
    updatedAt: known[0]?.updated_at ?? null,
    bestNetProfit: known[0]?.net_profit ?? null,
    series: buildSeries(txns, balances),
  };
}

interface TxnPoint {
  purchased_at: Date;
  kind: "buy" | "sell";
  price: number;
  quantity: number;
}

interface BalancePoint {
  recorded_at: Date;
  coin: number;
}

// Cumulative bought / sold / net over the whole transaction ledger, plus the balance line.
//
// This was a Postgres CTE with window functions in the Grafana panel. It is TypeScript now
// because the whole input is ~2.5k rows and the SQLite rewrite of that CTE (`::numeric` casts,
// `now()`, `LEFT JOIN … ON true`) would be all translation risk and no benefit.
//
// The balance line has two halves. From the first wallet snapshot onward it is real sampled
// data. Before it there are no samples at all — /v2/account/wallet only ever returns the
// current balance — so it is BACKFILLED by walking the known balance backwards through
// cumulative net TP flow. That backfill is approximate by construction: gold also moves outside
// the trading post.
function buildSeries(txns: TxnPoint[], balances: BalancePoint[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];

  let bought = 0;
  let sold = 0;
  let net = 0;
  const cum: { t: number; bought: number; sold: number; net: number }[] = [];
  for (const t of txns) {
    const value = t.price * t.quantity;
    if (t.kind === "buy") {
      bought += value;
      net -= value;
    } else {
      sold += value;
      net += value;
    }
    cum.push({ t: t.purchased_at.getTime(), bought, sold, net });
  }

  const anchor = balances[0];
  // Cumulative net at the instant of the first wallet snapshot: the last transaction at or
  // before it, or 0 if the snapshot predates every transaction.
  let netAtAnchor = 0;
  if (anchor) {
    for (const c of cum) {
      if (c.t <= anchor.recorded_at.getTime()) netAtAnchor = c.net;
      else break;
    }
  }

  for (const c of cum) {
    const backfilled =
      anchor && c.t < anchor.recorded_at.getTime() ? anchor.coin - (netAtAnchor - c.net) : null;
    points.push({ t: c.t, bought: c.bought, sold: c.sold, net: c.net, balance: backfilled });
  }

  // Real wallet snapshots. Only `balance` is known at these instants; the cumulative lines are
  // carried across the gap by the renderer rather than restated here.
  for (const b of balances) {
    points.push({
      t: b.recorded_at.getTime(),
      bought: NaN,
      sold: NaN,
      net: NaN,
      balance: b.coin,
    });
  }

  points.sort((a, b) => a.t - b.t);

  // Carry the last cumulative values to now, so the three TP lines reach the right edge
  // instead of stopping at the most recent trade.
  const last = cum[cum.length - 1];
  if (last) {
    points.push({ t: Date.now(), bought: last.bought, sold: last.sold, net: last.net, balance: null });
  }

  return points;
}
