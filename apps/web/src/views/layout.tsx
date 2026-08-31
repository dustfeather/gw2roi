import type { PropsWithChildren } from "hono/jsx";
import { APP_CSS_V } from "../styles.ts";

// One shell for every page. The board is behind Cloudflare Access, but the headers below are
// the cheap half of defence in depth and cost nothing to keep: no third-party anything, no
// inline script (the page has zero JavaScript), no framing.
export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>GW2 crafting ROI</title>
        <link rel="stylesheet" href={`/app.css?v=${APP_CSS_V}`} />
      </head>
      <body class="min-h-full bg-stone-950 text-stone-200 antialiased">{children}</body>
    </html>
  );
}
