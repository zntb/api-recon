/**
 * WCAG AA contrast for the shared theme.
 *
 * The palette is documented as one ramp with roles, so an artifact's contrast is
 * a property of the tokens rather than of any one component. This resolves the
 * light-mode roles and asserts every text pair used across the reports clears
 * AA, and that the accent used for focus rings clears the non-text 3:1 bar — so
 * a token edit that would quietly make a link or a status label unreadable fails
 * the build.
 */

import { describe, expect, it } from 'vitest';
import { THEME_TOKENS } from '../../src/reporters/theme.js';

/** The first (light-mode) value of a custom property, e.g. `--muted`. */
function rawToken(name: string): string {
  const match = THEME_TOKENS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`the theme does not define --${name}`);
  return match[1]!.trim();
}

/** Resolve a token through any `var(--x)` aliases to a literal (a colour). */
function token(name: string, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`--${name} is circular`);
  const value = rawToken(name);
  const alias = value.match(/^var\(--([^)]+)\)$/);
  return alias ? token(alias[1]!, [...seen, name]) : value;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

describe('theme contrast', () => {
  // Every text colour against the surface it is read on: 4.5:1 is WCAG AA for
  // normal text. The status pairs cover the badges, method chips, and coloured
  // tile numbers, which read on their own tinted surface.
  const textPairs: [string, string][] = [
    ['ink', 'panel'],
    ['ink', 'bg'],
    ['muted', 'panel'],
    ['muted', 'panel-2'],
    ['muted', 'bg'],
    ['muted', 'head'],
    ['link', 'panel'],
    ['link', 'panel-2'],
    ['link', 'bg'],
    ['chip-ink', 'chip'],
    ['ok', 'panel'],
    ['warn', 'panel'],
    ['bad', 'panel'],
    ['info', 'panel'],
    ['ok', 'ok-bg'],
    ['warn', 'warn-bg'],
    ['bad', 'bad-bg'],
    ['info', 'info-bg'],
  ];

  it.each(textPairs)('%s on %s meets WCAG AA (4.5:1)', (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // Focus rings and other non-text UI need 3:1 (WCAG 1.4.11).
  it.each([
    ['accent', 'panel'],
    ['accent', 'bg'],
  ])('%s on %s meets the non-text 3:1 bar', (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(3);
  });
});
