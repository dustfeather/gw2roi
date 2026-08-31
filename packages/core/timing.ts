// Wall-clock accounting per pipeline phase. A run is one `scheduled()` invocation, so there is
// nothing to attach a profiler to after the fact — the only forensics available are the log
// lines the run itself printed. Phases accumulate here and get rendered as one summary line
// at the end of the run (and on failure), which is what makes "the job now takes 12 minutes"
// answerable without re-running it locally.
const marks = new Map<string, number>();

// Module scope on Workers is per ISOLATE, not per invocation, and a warm isolate serves many
// scheduled() calls. Without this the second run on an isolate would report the first run's
// milliseconds added to its own. Called once at the top of the handler.
export function resetTimings(): void {
  marks.clear();
}

// Time `fn` under `name`. Works for sync and async callees; repeat calls with the same name
// accumulate rather than overwrite.
export async function phase<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    marks.set(name, (marks.get(name) ?? 0) + (Date.now() - t0));
  }
}

// "account=1234ms recipes=..." in insertion order, i.e. the order the phases ran.
export function timings(): string {
  return [...marks].map(([name, ms]) => `${name}=${ms}ms`).join(" ");
}
