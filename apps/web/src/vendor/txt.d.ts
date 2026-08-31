// `rules: [{ type: "Text", globs: ["**/*.txt"] }]` in wrangler.jsonc makes wrangler inline any
// imported .txt as a string module. This is the type side of that.
declare module "*.txt" {
  const content: string;
  export default content;
}
