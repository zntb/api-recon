/**
 * The product identity, embedded.
 *
 * The logo and favicon are inline/data-URI SVG rather than files on disk: the
 * reports are meant to be attached to a ticket, opened from `file://`, or kept
 * in CI artifacts, and an external asset would either break or need shipping
 * beside every report. The mark is drawn from the theme's brand ramp, so it
 * follows dark mode and the print palette like the rest of the page.
 */

/** The wordmark, as it appears in the page furniture and the report itself. */
export const BRAND_NAME = 'api-recon';

/** Two arcs of the signal, radiating from the point at (7, 17). */
const MARK_ARCS = '<path d="M7 13a4 4 0 0 1 4 4" /><path d="M7 8a9 9 0 0 1 9 9" />';

/**
 * The mark: a rounded tile with a signal radiating from a point — a scan, not a
 * spider. Rendered from ramp tokens, so `--brand-500`/`--brand-50` give it the
 * right contrast in light, dark, and print without a second definition.
 */
export function brandMark(size = 22): string {
  return (
    `<svg class="brand-mark" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `role="img" aria-label="${BRAND_NAME}" focusable="false">` +
    `<rect width="24" height="24" rx="6" fill="var(--brand-500)" />` +
    `<g fill="none" stroke="var(--brand-50)" stroke-width="2" stroke-linecap="round">` +
    MARK_ARCS +
    `</g>` +
    `<circle cx="7" cy="17" r="1.7" fill="var(--brand-50)" />` +
    `</svg>`
  );
}

/**
 * The favicon, as a data URI.
 *
 * A favicon is a separate document, so it cannot read the page's custom
 * properties — the ramp's light values are inlined here for that reason. It stays
 * a single `<link>` with no file to ship.
 */
export function faviconHref(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="6" fill="#4f6ef7" />` +
    `<g fill="none" stroke="#eef2ff" stroke-width="2.4" stroke-linecap="round">` +
    MARK_ARCS +
    `</g>` +
    `<circle cx="7" cy="17" r="2" fill="#eef2ff" />` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The `<link>` both artifacts put in `<head>`. */
export function faviconLink(): string {
  return `<link rel="icon" type="image/svg+xml" href="${faviconHref()}" />`;
}

/**
 * How the mark sits in a heading. Small, because it is a signature and not the
 * subject of the page.
 */
export const BRAND_STYLE = `
  .brand-mark { vertical-align: -0.3em; margin-right: .45rem; }
`;
