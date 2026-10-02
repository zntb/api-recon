/**
 * The shared design tokens for every HTML artifact.
 *
 * `report.html`, `dashboard.html`, and the docs site used to carry their own
 * palette, so a restyle meant editing several files that drifted apart.
 * Everything visual they have in common — the colour ramp, typography, spacing,
 * and the code-block treatment — is defined once here and interpolated into each
 * page's `<style>`.
 *
 * Tokens are plain CSS custom properties, so an artifact can still add its own
 * rules on top; it just should not invent a new colour to do it.
 *
 * The type system has three roles, because a recon report is a document and an
 * instrument at once: a serif display face gives headings and report prose their
 * voice, a neutral sans runs the controls, and mono carries machine data — paths,
 * methods, numbers, and code. The serif is a *system* stack rather than a webfont
 * so the artifacts stay one file with nothing fetched.
 */

/**
 * The colour ramp, and the roles built on it.
 *
 * Every hue is a named scale, and every artifact takes its colours from it: the
 * status badges, the graph edges, the focus rings, and the logo all resolve to a
 * ramp step rather than a literal. The legend ships with the stylesheet (see
 * `RAMP_LEGEND`), so a report's own source documents the palette it uses.
 *
 * The status hues (`green`, `amber`, `red`, `blue`) define only the steps they
 * use today; add a step to the ramp rather than a hex value to a component.
 * Surfaces and text (`--bg`, `--panel`, `--ink`, `--line`, …) are roles rather
 * than ramp steps, because print flattens them to greys instead of scaling them.
 */

/** What each ramp step means — the same role in every mode, at different values. */
const RAMP_LEGEND = `
    /* The ramp. Each step is a role, not a lightness: a component takes a step
       and one mode change restyles everything built on it.
         -50   tinted surface: badge, note, and row backgrounds
         -200  soft fill: accent borders, graph edges, quiet highlights
         -500  the hue at full strength: links, focus rings, the logo tile
         -600  the same one step down, for a pressed or hovered control
         -700  readable ink: status text and icons */`;
const LIGHT_RAMP = `
    --brand-50: #eef2ff; --brand-200: #c7d2fe; --brand-500: #4f6ef7;
    --brand-600: #3b55e0; --brand-700: #2f43b8;
    --green-50: #e7f6ef; --green-700: #027a48;
    --amber-50: #fdf2e4; --amber-700: #b54708;
    --red-50: #fdeceb; --red-700: #b42318;
    --blue-50: #e8f0fe; --blue-700: #0552b5;`;

const DARK_RAMP = `
    --brand-50: #131d2e; --brand-200: #33406b; --brand-500: #8da2ff;
    --brand-600: #a9b8ff; --brand-700: #c7d2fe;
    --green-50: #10301f; --green-700: #4ade80;
    --amber-50: #33260d; --amber-700: #fbbf24;
    --red-50: #3a1a1c; --red-700: #f87171;
    --blue-50: #10263a; --blue-700: #7dd3fc;`;

export const THEME_TOKENS = `
  :root {
    color-scheme: light;${RAMP_LEGEND}${LIGHT_RAMP}
    /* surfaces, text, and the status roles built on the ramp. The neutrals are
       cool steel blues rather than true greys, so the brand hue sits on the page
       as one family instead of a colour dropped onto a neutral ground. */
    --line: #dde3ec; --muted: #566276; --ink: #16202c;
    --bg: #f3f6fa; --panel: #ffffff; --panel-2: #f8fafc; --head: #edf1f7;
    --head-hover: #e2e9f4; --row-hover: #f4f7fb; --row-open: #eef3fb;
    --row-removed: #fff6f5; --row-removed-hover: #fdeceb;
    --chip: #eaeef4; --chip-ink: #3d475a; --input-border: #c6cfdd;
    --ok: var(--green-700); --ok-bg: var(--green-50);
    --warn: var(--amber-700); --warn-bg: var(--amber-50);
    --bad: var(--red-700); --bad-bg: var(--red-50);
    --info: var(--blue-700); --info-bg: var(--blue-50);
    --accent: var(--brand-500); --accent-soft: var(--brand-200); --note-bg: var(--brand-50);
    /* Link and accent-coloured *text*. --accent is the brand hue at full
       strength, for focus rings and fills; as text on a light surface it lands at
       4.3:1, below AA. Links take the ramp's readable-ink step instead, and it
       follows the dark and print overrides because it points at --brand-700. */
    --link: var(--brand-700);
    --shadow: 0 1px 2px rgba(16,24,40,.05);
    --pre-bg: #0f172a; --pre-ink: #e2e8f0;
    /* typography: display (a document voice), sans (controls), mono (data). */
    --font-display: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "Times New Roman", Georgia, serif;
    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    /* spacing & shape: a tight radius set, with a pill reserved for chips, so not
       everything on the page rounds to the same corner. */
    --radius: 10px; --radius-sm: 6px; --space: 1rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      /* Only the ramp and the surfaces change; the roles above follow, because
         they point at these names. */${DARK_RAMP}
      --line: #26313f; --muted: #93a0b3; --ink: #e8edf4;
      --bg: #0c1219; --panel: #141c26; --panel-2: #111923; --head: #1a2330;
      --head-hover: #232f40; --row-hover: #1a2330; --row-open: #1c2738;
      --row-removed: #2a1a1c; --row-removed-hover: #361f22;
      --chip: #212b39; --chip-ink: #c2cddb; --input-border: #364254;
      --shadow: 0 1px 2px rgba(0,0,0,.45);
      --pre-bg: #0a0f17; --pre-ink: #e2e8f0;
    }
  }
  @media print {
    :root {
      color-scheme: light;
      /* Paper has no dark mode, so printing pins the ramp to its light values
         whatever scheme the machine is in — otherwise a report printed from a
         dark desktop would put dark ink on a black tile. The status tints are
         kept as-is (they read fine on paper); the brand and the surfaces are
         flattened, so a printed page is ink and rules. */${LIGHT_RAMP}
      --brand-200: #bbbbbb; --brand-500: #000000;
      --line: #cccccc; --muted: #444444; --ink: #000000;
      --bg: #ffffff; --panel: #ffffff; --panel-2: #ffffff; --head: #ffffff;
      --head-hover: #ffffff; --row-hover: #ffffff; --row-open: #ffffff;
      --row-removed: #ffffff; --row-removed-hover: #ffffff;
      --chip: #f0f0f0; --chip-ink: #000000; --input-border: #cccccc;
      --note-bg: #f7f7f7;
      --shadow: none;
      --pre-bg: #f4f4f5; --pre-ink: #111111;
    }
  }
`;

/**
 * The page → request graph (see `graph.ts`). Styling lives here rather than in
 * the generated SVG so the two columns take their colours from the same tokens
 * as everything else and follow the dark and print overrides.
 */
export const GRAPH_STYLE = `
  .request-graph { max-width: 100%; height: auto; display: block; }
  .request-graph text { font-family: var(--font-mono); font-size: 11px; fill: var(--ink); }
  .request-graph .rg-page rect { fill: var(--head); stroke: var(--line); }
  .request-graph .rg-request rect { fill: var(--panel); stroke: var(--line); }
  .request-graph .rg-edge { fill: none; stroke: var(--accent-soft); }
  .graph-note { color: var(--muted); font-size: .85em; }
`;

/**
 * The code treatment shared by every artifact: a dark block that scrolls
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
