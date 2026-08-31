// The board: stat row, full-width cumulative TP graph, then the two ROI tables side by side.
//
// The two-up row is deliberate. `craft_roi` routinely holds a handful of rows — TOP_N is 100
// but the velocity gates cut hard, and a thin board is a gate artifact rather than a bug.
// Stacking two three-row tables under a full-width graph looks broken; side by side it looks
// deliberate, and it still degrades sanely if a game patch floods the board.
import { fmtCoin } from "@gw2/core";
import type { BoardData, KnownRow, LearnableRow } from "../data.ts";
import { TpChart } from "./chart.tsx";

// `net_profit` and its ROI, as one cell: "12g 34s 56c (18.2%)", or "(free)" when the craft
// costs no cash at all because every ingredient was already in the account.
function profitCell(r: { net_profit: number; net_roi_pct: number; out_of_pocket: number }) {
  const roi = r.out_of_pocket > 0 ? `${r.net_roi_pct.toFixed(1)}%` : "free";
  return `${fmtCoin(r.net_profit)} (${roi})`;
}

function demandCell(r: { sell_sold_day: number; days_to_sell: number }) {
  return `${r.sell_sold_day}/d in ${r.days_to_sell.toFixed(2)}d`;
}

// The gw2efficiency crafting calculator takes the output item id inline in its state string.
function calculatorUrl(itemId: number): string {
  return `https://gw2efficiency.com/crafting/calculator/a~1!b~0!c~1!d~1-${itemId}!e~0!f~1`;
}

// Recipe sheets are a wiki lookup — vendor and currency are not in the GW2 API at all.
function wikiRecipeUrl(name: string): string {
  return `https://wiki.guildwars2.com/wiki/Recipe:%20${encodeURIComponent(name)}`;
}

function relativeAge(then: Date, now: number): string {
  const mins = Math.round((now - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div class="rounded-lg border border-stone-700/60 bg-stone-900/60 px-5 py-4">
      <div class="text-xs uppercase tracking-wide text-stone-400">{label}</div>
      <div class="mt-1 text-2xl font-semibold text-amber-200" title={title}>
        {value}
      </div>
    </div>
  );
}

function Table({
  title,
  subtitle,
  rows,
  href,
  empty,
}: {
  title: string;
  subtitle: string;
  rows: (KnownRow | LearnableRow)[];
  href: (r: KnownRow | LearnableRow) => string;
  empty: string;
}) {
  return (
    <section class="min-w-0 rounded-lg border border-stone-700/60 bg-stone-900/60">
      <header class="border-b border-stone-700/60 px-5 py-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-amber-200">{title}</h2>
        <p class="text-xs text-stone-400">{subtitle}</p>
      </header>
      {rows.length === 0 ? (
        <p class="px-5 py-6 text-sm text-stone-400">{empty}</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs uppercase tracking-wide text-stone-400">
                <th class="px-5 py-2 text-left font-medium">Item</th>
                <th class="px-5 py-2 text-right font-medium">Net profit</th>
                <th class="px-5 py-2 text-right font-medium">Demand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class="border-t border-stone-800 hover:bg-stone-800/40">
                  <td class="px-5 py-2">
                    <a
                      class="text-amber-200 underline decoration-amber-200/30 underline-offset-2 hover:decoration-amber-200"
                      href={href(r)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {r.output_item_name || `#${r.output_item_id}`}
                    </a>
                    {r.output_item_count > 1 ? (
                      <span class="ml-2 text-xs text-stone-500">x{r.output_item_count}</span>
                    ) : null}
                    {"learn_method" in r && r.learn_method ? (
                      <span class="ml-2 rounded bg-stone-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-300">
                        {r.learn_method}
                      </span>
                    ) : null}
                  </td>
                  <td class="whitespace-nowrap px-5 py-2 text-right tabular-nums">
                    {profitCell(r)}
                  </td>
                  <td class="whitespace-nowrap px-5 py-2 text-right tabular-nums text-stone-300">
                    {demandCell(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Board({ data, now }: { data: BoardData; now: number }) {
  return (
    <main class="mx-auto flex max-w-[1600px] flex-col gap-5 p-5">
      <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 class="text-lg font-semibold text-amber-100">GW2 crafting ROI</h1>
        <p class="text-xs text-stone-400">
          Ranked by net profit per craft — market cost minus what the account already holds.
        </p>
      </header>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Best net profit (per craft)"
          value={data.bestNetProfit === null ? "—" : fmtCoin(data.bestNetProfit)}
        />
        <Stat
          label="Last updated"
          value={data.updatedAt === null ? "never" : relativeAge(data.updatedAt, now)}
          title={data.updatedAt?.toISOString()}
        />
        <Stat label="Craftable now" value={String(data.known.length)} />
        <Stat label="Learnable" value={String(data.learnable.length)} />
      </div>

      <section class="rounded-lg border border-stone-700/60 bg-stone-900/60 p-5">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-200">
          Trading post — cumulative bought vs sold vs net
        </h2>
        <TpChart points={data.series} />
      </section>

      <div class="grid gap-5 xl:grid-cols-2">
        <Table
          title="Craftable now"
          subtitle="Recipes the account can craft today, craft-and-list economics"
          rows={data.known}
          href={(r) => calculatorUrl(r.output_item_id)}
          empty="Nothing clears the gates right now. A thin board is a velocity-gate artifact, not a pricing bug."
        />
        <Table
          title="Learnable"
          subtitle="Disciplines qualify, recipe not unlocked yet — DISCOVER is free, BUY needs a sheet"
          rows={data.learnable}
          href={(r) => wikiRecipeUrl(r.output_item_name)}
          empty="Nothing clears the gates right now."
        />
      </div>
    </main>
  );
}
