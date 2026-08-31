// Copper -> "Xg Ys Zc". Was `fmt_coin(bigint)`, a PL/pgSQL function created by the old inline
// DDL so panel SQL could stay DRY; SQLite has no stored functions, so it lives here and the
// board formats at render time.
//
// That move also removes a bug class. The Grafana panels selected `fmt_coin(profit) AS profit`,
// and PostgreSQL resolves a bare `ORDER BY profit` against the output ALIAS first — a silent
// lexicographic sort that put "2g 3s 43c" above "2g 27s 17c". Formatting after the sort means
// the raw integer is the only thing ever ordered, so the trap cannot recur.
export function fmtCoin(copper: number): string {
  const sign = copper < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(copper));
  return `${sign}${Math.floor(abs / 10000)}g ${Math.floor((abs % 10000) / 100)}s ${abs % 100}c`;
}
