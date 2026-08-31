// Tailwind output, built by `pnpm build:css` (@tailwindcss/cli) into a committed `.css.txt` and
// pulled in as a Text module via the `rules` entry in wrangler.jsonc — the `invest` pattern.
// The .txt is committed so `tsc` and CI work on a fresh checkout without running the build.
import APP_CSS_TEXT from "./vendor/app.css.txt";

export const APP_CSS: string = APP_CSS_TEXT;

// Content hash, so `/app.css?v=…` can be served immutable and still change when the CSS does.
export const APP_CSS_V: string = assetVersion(APP_CSS);

function assetVersion(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (Math.imul(h, 31) + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
