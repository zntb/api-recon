/**
 * Known third-party and analytics vendors, matched by request host.
 *
 * `ANALYTICS_HOSTS` in the analyzer used to be a flat list of host fragments,
 * and the technology fingerprints named vendors separately, so a call to
 * `api.segment.io` and a `cdn.segment.com` script had no shared identity. This
 * catalog is the single place a vendor's name, category, and hosts live, so
 * endpoint attribution and technology detection agree on "Segment".
 *
 * Matching is by host suffix only — a host matches when it equals a domain or
 * ends with `.` + the domain — so `notstripe.com` is not mistaken for Stripe.
 */

import type { VendorAttribution } from '../types.js';

export interface Vendor {
  name: string;
  /** The vendor's discipline, e.g. `analytics`, `payments`, `monitoring`. */
  category: string;
  /** Host suffixes that identify the vendor. */
  domains: string[];
}

/** Categories whose traffic the endpoint categorizer buckets as `analytics`. */
export const TRACKING_CATEGORIES: ReadonlySet<string> = new Set([
  'analytics',
  'advertising',
  'monitoring',
]);

export const VENDORS: readonly Vendor[] = [
  // --- analytics & advertising ---
  { name: 'Google Analytics', category: 'analytics', domains: ['google-analytics.com', 'analytics.google.com'] },
  { name: 'Google Tag Manager', category: 'analytics', domains: ['googletagmanager.com'] },
  { name: 'Google Ads', category: 'advertising', domains: ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com'] },
  { name: 'Segment', category: 'analytics', domains: ['segment.io', 'segment.com'] },
  { name: 'Mixpanel', category: 'analytics', domains: ['mixpanel.com', 'mxpnl.com'] },
  { name: 'Amplitude', category: 'analytics', domains: ['amplitude.com'] },
  { name: 'Hotjar', category: 'analytics', domains: ['hotjar.com'] },
  { name: 'FullStory', category: 'analytics', domains: ['fullstory.com'] },
  { name: 'Microsoft Clarity', category: 'analytics', domains: ['clarity.ms'] },
  { name: 'Plausible', category: 'analytics', domains: ['plausible.io'] },
  { name: 'PostHog', category: 'analytics', domains: ['posthog.com'] },
  { name: 'Matomo', category: 'analytics', domains: ['matomo.cloud'] },
  { name: 'Snowplow', category: 'analytics', domains: ['snowplow.io', 'snowplowanalytics.com'] },
  { name: 'Meta Pixel', category: 'advertising', domains: ['facebook.com', 'facebook.net'] },
  { name: 'TikTok Pixel', category: 'advertising', domains: ['tiktok.com'] },
  // --- monitoring ---
  { name: 'Sentry', category: 'monitoring', domains: ['sentry.io'] },
  { name: 'Datadog', category: 'monitoring', domains: ['datadoghq.com'] },
  { name: 'New Relic', category: 'monitoring', domains: ['newrelic.com'] },
  // --- commerce & payments ---
  { name: 'Stripe', category: 'payments', domains: ['stripe.com', 'stripe.network'] },
  { name: 'PayPal', category: 'payments', domains: ['paypal.com', 'paypalobjects.com'] },
  { name: 'Braintree', category: 'payments', domains: ['braintreegateway.com', 'braintree-api.com'] },
  { name: 'Adyen', category: 'payments', domains: ['adyen.com'] },
  { name: 'Plaid', category: 'payments', domains: ['plaid.com'] },
  { name: 'Shopify', category: 'commerce', domains: ['shopify.com', 'shopifycdn.com', 'myshopify.com'] },
  // --- support, CRM & communications ---
  { name: 'Intercom', category: 'support', domains: ['intercom.io', 'intercomcdn.com'] },
  { name: 'Zendesk', category: 'support', domains: ['zendesk.com'] },
  { name: 'HubSpot', category: 'crm', domains: ['hubspot.com', 'hubapi.com', 'hs-scripts.com'] },
  { name: 'Salesforce', category: 'crm', domains: ['salesforce.com', 'force.com'] },
  { name: 'Twilio', category: 'communications', domains: ['twilio.com'] },
  { name: 'SendGrid', category: 'email', domains: ['sendgrid.com', 'sendgrid.net'] },
  // --- platform services ---
  { name: 'Algolia', category: 'search', domains: ['algolia.net', 'algolianet.com', 'algolia.io'] },
  { name: 'Mapbox', category: 'maps', domains: ['mapbox.com'] },
  { name: 'Firebase', category: 'backend', domains: ['firebaseio.com', 'firebaseapp.com', 'firebase.google.com'] },
  { name: 'Supabase', category: 'backend', domains: ['supabase.co'] },
  { name: 'Auth0', category: 'auth', domains: ['auth0.com'] },
  { name: 'Okta', category: 'auth', domains: ['okta.com', 'oktapreview.com'] },
];

const BY_NAME = new Map(VENDORS.map((vendor) => [vendor.name, vendor]));

/** The catalog entry for a vendor name, so other modules can share its category. */
export function vendorByName(name: string): Vendor | undefined {
  return BY_NAME.get(name);
}

/** The vendor that owns a host, or null when the host is not recognized. */
export function vendorForHost(host: string): Vendor | null {
  const normalized = host.toLowerCase();
  for (const vendor of VENDORS) {
    if (vendor.domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))) {
      return vendor;
    }
  }
  return null;
}

/** The vendor a URL belongs to, or null when it is unknown or unparseable. */
export function findVendor(url: string): Vendor | null {
  try {
    return vendorForHost(new URL(url).host);
  } catch {
    return null;
  }
}

/** True when a host belongs to a tracking (analytics/advertising/monitoring) vendor. */
export function isTrackingHost(host: string): boolean {
  const vendor = vendorForHost(host);
  return vendor !== null && TRACKING_CATEGORIES.has(vendor.category);
}

/** Host suffixes of every tracking vendor, for callers that want the raw list. */
export function trackingVendorDomains(): string[] {
  return VENDORS.filter((vendor) => TRACKING_CATEGORIES.has(vendor.category)).flatMap(
    (vendor) => vendor.domains,
  );
}

/**
 * Attribute an endpoint to a vendor from its origins, carrying the payload keys
 * observed being sent to it. The first origin that matches wins, so an endpoint
 * seen on several hosts keeps the vendor of the one it was matched by.
 */
export function attributeVendor(
  origins: string[],
  payloadKeys: string[],
): VendorAttribution | null {
  for (const origin of origins) {
    const vendor = findVendor(origin);
    if (vendor) return { name: vendor.name, category: vendor.category, payloadKeys };
  }
  return null;
}
