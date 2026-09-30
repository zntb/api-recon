/** Lightweight technology fingerprinting from headers, HTML, scripts, and cookies. */

import type { Technology } from '../types.js';
import { vendorByName } from './vendors.js';

/**
 * A vendor's category is defined once, in the vendor catalog, so the name in the
 * technologies table and the name attributed to its traffic can never disagree.
 */
function vendorCategory(name: string, fallback: string): string {
  return vendorByName(name)?.category ?? fallback;
}

export interface TechEvidence {
  url: string;
  headers: Record<string, string>;
  html: string;
  cookies: string[];
  scripts: string[];
}

interface Signature {
  name: string;
  category: string;
  /** Returns a human-readable evidence string when matched. */
  match: (e: TechEvidence) => string | null | undefined | false;
}

const SIGNATURES: Signature[] = [
  {
    name: 'Express',
    category: 'framework',
    match: (e) =>
      (/express/i.test(e.headers['x-powered-by'] ?? '') && 'x-powered-by: Express') ||
      (e.cookies.some((c) => c === 'connect.sid') && 'cookie: connect.sid'),
  },
  {
    name: 'PHP',
    category: 'language',
    match: (e) =>
      (/php/i.test(e.headers['x-powered-by'] ?? '') && 'x-powered-by: PHP') ||
      (e.cookies.some((c) => c === 'PHPSESSID') && 'cookie: PHPSESSID'),
  },
  {
    name: 'Next.js',
    category: 'framework',
    match: (e) =>
      (e.html.includes('__NEXT_DATA__') && 'html: __NEXT_DATA__') ||
      (e.scripts.some((s) => s.includes('/_next/')) && 'script: /_next/') ||
      (e.headers['x-nextjs-cache'] && 'header: x-nextjs-cache'),
  },
  {
    name: 'React',
    category: 'ui-library',
    match: (e) =>
      (e.html.includes('data-reactroot') && 'html: data-reactroot') ||
      (e.html.includes('__REACT_DEVTOOLS_GLOBAL_HOOK__') && 'html: react devtools hook') ||
      (e.scripts.some((s) => /react(\.production|\.development)?(\.min)?\.js/i.test(s)) && 'script: react'),
  },
  {
    name: 'Vue.js',
    category: 'ui-library',
    match: (e) =>
      (e.html.includes('data-v-') && 'html: data-v-* attributes') ||
      (e.scripts.some((s) => /vue(\.global)?(\.min)?\.js/i.test(s)) && 'script: vue'),
  },
  {
    name: 'Angular',
    category: 'ui-library',
    match: (e) =>
      (/ng-version=/.test(e.html) && 'html: ng-version attribute') ||
      (e.scripts.some((s) => /angular(\.min)?\.js/i.test(s)) && 'script: angular'),
  },
  {
    name: 'jQuery',
    category: 'ui-library',
    match: (e) =>
      e.scripts.some((s) => /jquery(-[\d.]+)?(\.min)?\.js/i.test(s)) ? 'script: jquery' : null,
  },
  {
    name: 'WordPress',
    category: 'cms',
    match: (e) =>
      (e.html.includes('wp-content') && 'html: wp-content') ||
      (e.scripts.some((s) => s.includes('/wp-includes/')) && 'script: /wp-includes/'),
  },
  {
    name: 'Cloudflare',
    category: 'cdn',
    match: (e) => (e.headers['cf-ray'] && 'header: cf-ray') || (e.cookies.some((c) => c === '__cf_bm') && 'cookie: __cf_bm'),
  },
  {
    name: 'Vercel',
    category: 'hosting',
    match: (e) => (e.headers['x-vercel-id'] && 'header: x-vercel-id') || (e.headers['server']?.includes('Vercel') ? 'server: Vercel' : null),
  },
  {
    name: 'nginx',
    category: 'web-server',
    match: (e) => (e.headers['server']?.toLowerCase().includes('nginx') ? 'server: nginx' : null),
  },
  {
    name: 'Apache',
    category: 'web-server',
    match: (e) => (e.headers['server']?.toLowerCase().includes('apache') ? 'server: Apache' : null),
  },
  {
    name: 'Google Analytics',
    category: vendorCategory('Google Analytics', 'analytics'),
    match: (e) =>
      (e.scripts.some((s) => /googletagmanager\.com|google-analytics\.com|gtag\/js/.test(s)) && 'script: gtag') ||
      (e.html.includes('gtag(') && 'html: gtag()'),
  },
  {
    name: 'Google Tag Manager',
    category: vendorCategory('Google Tag Manager', 'analytics'),
    match: (e) => (e.scripts.some((s) => s.includes('googletagmanager.com/gtm')) ? 'script: gtm' : null),
  },
  {
    name: 'Segment',
    category: vendorCategory('Segment', 'analytics'),
    match: (e) => (e.scripts.some((s) => s.includes('cdn.segment.com')) ? 'script: segment' : null),
  },
  {
    name: 'Mixpanel',
    category: vendorCategory('Mixpanel', 'analytics'),
    match: (e) => (e.scripts.some((s) => s.includes('cdn.mxpnl.com')) ? 'script: mixpanel' : null),
  },
  {
    name: 'Hotjar',
    category: vendorCategory('Hotjar', 'analytics'),
    match: (e) => (e.scripts.some((s) => s.includes('static.hotjar.com')) ? 'script: hotjar' : null),
  },
  {
    name: 'Sentry',
    category: vendorCategory('Sentry', 'monitoring'),
    match: (e) =>
      (e.scripts.some((s) => s.includes('browser.sentry-cdn.com') || s.includes('sentry.io')) && 'script: sentry') ||
      (e.html.includes('Sentry.init') && 'html: Sentry.init'),
  },
  {
    name: 'Django',
    category: 'framework',
    match: (e) => (e.cookies.some((c) => c === 'csrftoken') ? 'cookie: csrftoken' : null),
  },
  {
    name: 'Laravel',
    category: 'framework',
    match: (e) => (e.cookies.some((c) => c.startsWith('laravel_session')) ? 'cookie: laravel_session' : null),
  },
  {
    name: 'Java',
    category: 'language',
    match: (e) => (e.cookies.some((c) => c === 'JSESSIONID') ? 'cookie: JSESSIONID' : null),
  },
];

export function detectTechnologies(evidence: TechEvidence[]): Technology[] {
  const found = new Map<string, Technology>();
  for (const e of evidence) {
    for (const sig of SIGNATURES) {
      const why = sig.match(e);
      if (typeof why === 'string' && why.length > 0 && !found.has(sig.name)) {
        found.set(sig.name, { name: sig.name, category: sig.category, evidence: why });
      }
    }
    const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(e.html)?.[1];
    if (generator && !found.has(generator)) {
      found.set(generator, { name: generator, category: 'generator', evidence: 'meta: generator' });
    }
  }
  return [...found.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
