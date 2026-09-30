/**
 * The shared design tokens for every HTML artifact.
 *
 * `report.html` and `dashboard.html` used to carry their own palette, so a
 * restyle meant editing two files that drifted apart. Everything visual that the
 * two have in common — colours, typography, spacing, and the code-block
 * treatment — is defined once here and interpolated into each page's `<style>`.
 *
 * Tokens are plain CSS custom properties, so an artifact can still add its own
 * rules on top; it just should not invent a new colour to do it.
 */

/** Colour, typography, and spacing tokens, with the dark and print overrides. */
export const THEME_TOKENS = `
  :root {
    color-scheme: light;
    /* colour */
    --line: #e3e7ee; --muted: #5b6675; --ink: #1c2430;
    --bg: #f6f7f9; --panel: #ffffff; --panel-2: #fbfcfe; --head: #f4f6fa;
    --head-hover: #e9eef7; --row-hover: #f7f9fd; --row-open: #f2f5fd;
    --row-removed: #fff7f6; --row-removed-hover: #fdeceb;
    --chip: #eef1f6; --chip-ink: #404a5c; --input-border: #cbd3df;
    --ok: #027a48; --ok-bg: #e7f6ef; --warn: #b54708; --warn-bg: #fdf2e4;
    --bad: #b42318; --bad-bg: #fdeceb; --info: #0552b5; --info-bg: #e8f0fe;
    --accent: #4f6ef7; --accent-soft: #c7d2fe; --note-bg: #f8faff;
    --shadow: 0 1px 2px rgba(16,24,40,.04);
    --pre-bg: #0f172a; --pre-ink: #e2e8f0;
    /* typography */
    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    /* spacing & shape */
    --radius: 12px; --radius-sm: 7px; --space: 1rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --line: #2a3342; --muted: #97a3b4; --ink: #e6ebf2;
      --bg: #0e131b; --panel: #161d27; --panel-2: #131a23; --head: #1b2330;
      --head-hover: #243043; --row-hover: #1b2330; --row-open: #1d2738;
      --row-removed: #2a1a1c; --row-removed-hover: #361f22;
      --chip: #232d3b; --chip-ink: #c4cfdd; --input-border: #38445a;
      --ok: #4ade80; --ok-bg: #10301f; --warn: #fbbf24; --warn-bg: #33260d;
      --bad: #f87171; --bad-bg: #3a1a1c; --info: #7dd3fc; --info-bg: #10263a;
      --accent: #8da2ff; --accent-soft: #33406b; --note-bg: #131d2e;
      --shadow: 0 1px 2px rgba(0,0,0,.45);
      --pre-bg: #0b1018; --pre-ink: #e2e8f0;
    }
  }
  @media print {
    :root {
      color-scheme: light;
      --line: #cccccc; --muted: #444444; --ink: #000000;
      --bg: #ffffff; --panel: #ffffff; --panel-2: #ffffff; --head: #ffffff;
      --head-hover: #ffffff; --row-hover: #ffffff; --row-open: #ffffff;
      --row-removed: #ffffff; --row-removed-hover: #ffffff;
      --chip: #f0f0f0; --chip-ink: #000000; --input-border: #cccccc;
      --accent: #000000; --accent-soft: #bbbbbb; --note-bg: #f7f7f7;
      --shadow: none;
      --pre-bg: #f4f4f5; --pre-ink: #111111;
    }
  }
`;

/**
 * The code treatment shared by both artifacts: a dark block that scrolls
 * horizontally rather than wrapping (source code and payloads are read as they
 * were written), and inline code that does not invent its own colours.
 *
 * `.table-scroll` is the same idea for tables: a table with an unbreakable cell
 * — a long URL, a base64 payload — scrolls inside its own box instead of
 * widening the page.
 */
export const CODE_STYLE = `
  code { font-family: var(--font-mono); font-size: .88em; background: var(--chip);
    color: var(--chip-ink); padding: .12em .35em; border-radius: 4px; }
  pre { margin: 0; background: var(--pre-bg); color: var(--pre-ink); padding: 1rem 1.1rem;
    border-radius: 8px; overflow-x: auto; font-size: .82rem; line-height: 1.45; }
  pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
  .table-scroll { overflow-x: auto; }
`;
