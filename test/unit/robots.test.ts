import { describe, expect, it } from 'vitest';
import { parseRobots } from '../../src/utils/robots.js';

const make = (raw: string | null) => parseRobots(raw);

describe('parseRobots', () => {
  it('allows everything when robots.txt is missing', () => {
    const { isAllowed, rules } = make(null);
    expect(isAllowed('/anything')).toBe(true);
    expect(rules.raw).toBeNull();
  });

  it('respects disallow rules for all agents', () => {
    const { isAllowed } = make(`
User-agent: *
Disallow: /admin
Disallow: /private/
    `);
    expect(isAllowed('/admin')).toBe(false);
    expect(isAllowed('/admin/panel')).toBe(false);
    expect(isAllowed('/private/x')).toBe(false);
    expect(isAllowed('/products')).toBe(true);
  });

  it('honors allow-overrides for longer matches', () => {
    const { isAllowed } = make(`
User-agent: *
Disallow: /
Allow: /public
    `);
    expect(isAllowed('/private')).toBe(false);
    expect(isAllowed('/public/page')).toBe(true);
  });

  it('uses the most specific user-agent group', () => {
    const { isAllowed } = make(`
User-agent: *
Disallow: /a

User-agent: apireconbot
Disallow: /b
    `);
    expect(isAllowed('/a', 'apireconbot')).toBe(true);
    expect(isAllowed('/b', 'apireconbot')).toBe(false);
    expect(isAllowed('/a', 'someotherbot')).toBe(false);
    expect(isAllowed('/b', 'someotherbot')).toBe(true);
  });

  it('parses crawl-delay and sitemaps', () => {
    const { rules } = make(`
User-agent: *
Disallow: /x
Crawl-delay: 2
Sitemap: https://a.com/sitemap.xml
    `);
    expect(rules.crawlDelaySeconds).toBe(2);
    expect(rules.sitemaps).toEqual(['https://a.com/sitemap.xml']);
  });

  it('ignores comments and empty disallow lines', () => {
    const { isAllowed } = make(`
# full comment
User-agent: *   # trailing comment
Disallow:       # means allow everything
Disallow: /only-this
    `);
    expect(isAllowed('/only-this')).toBe(false);
    expect(isAllowed('/everything-else')).toBe(true);
  });

  it('accepts absolute URLs as input', () => {
    const { isAllowed } = make(`
User-agent: *
Disallow: /admin
    `);
    expect(isAllowed('https://a.com/admin/keys')).toBe(false);
    expect(isAllowed('https://a.com/ok')).toBe(true);
  });
});
