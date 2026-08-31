// The board. `fetch()` only — server-rendered from D1 on every request, so the binding, the
// queries and the whole ledger stay server-side and the page ships zero JavaScript.
//
// It shares `packages/core` with the cron Worker but never writes: no ARENA_NET_KEY, no GW2
// API calls, and a redeploy here cannot disturb the hourly job.
import { Hono } from "hono";
import { createDb } from "@gw2/core";
import { loadBoard } from "./data.ts";
import { Board } from "./views/board.tsx";
import { Layout } from "./views/layout.tsx";
import { APP_CSS } from "./styles.ts";

export interface Env {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // The board changes hourly and is per-account data behind Access; never let a shared cache
  // hold it.
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
};

app.get("/", async (c) => {
  const data = await loadBoard(createDb(c.env.DB));
  return c.html(
    <Layout>
      <Board data={data} now={Date.now()} />
    </Layout>,
    200,
    HTML_HEADERS,
  );
});

// Served from the Text module, content-hashed in the URL, so it can be immutable.
app.get("/app.css", (c) =>
  c.body(APP_CSS, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
  }),
);

app.notFound((c) => c.text("not found", 404));

app.onError((err, c) => {
  console.error("board failed:", err instanceof Error ? (err.stack ?? err.message) : err);
  return c.text("board unavailable", 500);
});

export default app;
