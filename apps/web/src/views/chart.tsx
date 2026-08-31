// Cumulative trading-post graph, rendered as inline SVG on the server.
//
// No client-side charting library: the page has one chart, the whole series is already in
// memory to render the tables anyway, and an inline <svg> keeps the strict CSP (`script-src
// 'none'`) that a read-only board should have. It is also the only form that survives the
// board being behind Access without a second authenticated request.
import { WINDOW_DAYS, type SeriesPoint } from "../data.ts";

const W = 1000;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

const SERIES = [
  { key: "bought", label: "bought", color: "#e0575b", dash: null },
  { key: "sold", label: "sold", color: "#56b47f", dash: null },
  { key: "net", label: "net", color: "#6ea8fe", dash: null },
  // The balance line is dashed because half of it is reconstructed rather than sampled: before
  // the first wallet snapshot it is cumulative TP flow walked backwards from a known balance,
  // and gold moves outside the trading post too.
  { key: "balance", label: "balance (backfilled before first snapshot)", color: "#f5e6c8", dash: "8 6" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

const COPPER_PER_GOLD = 10000;

function value(p: SeriesPoint, key: SeriesKey): number | null {
  const v = key === "balance" ? p.balance : p[key];
  return v === null || !Number.isFinite(v) ? null : v / COPPER_PER_GOLD;
}

// One `d` per series, breaking the path at gaps rather than drawing through them — the wallet
// snapshots and the transaction points sit at different instants, so every series is sparse.
function path(
  points: SeriesPoint[],
  key: SeriesKey,
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let open = false;
  for (const p of points) {
    const v = value(p, key);
    if (v === null) continue;
    d += `${open ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
    open = true;
  }
  return d;
}

function fmtGold(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${Math.round(v / 1000)}k`;
  if (abs >= 10) return String(Math.round(v));
  return v.toFixed(1);
}

function fmtDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function TpChart({ points }: { points: SeriesPoint[] }) {
  if (points.length < 2) {
    return <p class="text-sm text-stone-400">No trading-post history yet.</p>;
  }

  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1, t1 - t0);

  // Both bounds come from the data. They used to be seeded at 0, which pinned the axis to the
  // origin — fine when the graph spanned the whole ledger and started there anyway, but with a
  // 30-day window over all-time cumulative totals it would squash every line into a flat band at
  // the top of the plot. Zero is included below only when the data actually crosses it.
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    for (const s of SERIES) {
      const v = value(p, s.key);
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return <p class="text-sm text-stone-400">No trading-post history yet.</p>;
  }
  if (hi === lo) hi = lo + 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);

  return (
    <figure class="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cumulative trading post bought, sold, net and account balance, in gold, over the last ${WINDOW_DAYS} days`}
        class="w-full h-auto"
      >
        {ticks.map((v) => (
          <g>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="#3f3a33"
              stroke-width="1"
            />
            <text x={PAD.left - 8} y={y(v) + 4} text-anchor="end" font-size="11" fill="#a8a29e">
              {fmtGold(v)}
            </text>
          </g>
        ))}

        {SERIES.map((s) => (
          <path
            d={path(points, s.key, x, y)}
            fill="none"
            stroke={s.color}
            stroke-width="2"
            stroke-dasharray={s.dash ?? undefined}
            stroke-linejoin="round"
          />
        ))}

        <text x={PAD.left} y={H - 8} font-size="11" fill="#a8a29e">
          {fmtDate(t0)}
        </text>
        <text x={W - PAD.right} y={H - 8} text-anchor="end" font-size="11" fill="#a8a29e">
          {fmtDate(t1)}
        </text>
      </svg>

      <figcaption class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-stone-400">
        {SERIES.map((s) => (
          <span class="inline-flex items-center gap-2">
            <span
              class="inline-block h-0.5 w-5"
              style={`background:${s.color}`}
              aria-hidden="true"
            />
            {s.label}
          </span>
        ))}
        <span class="ml-auto">gold, cumulative — last {WINDOW_DAYS} days</span>
      </figcaption>
    </figure>
  );
}
