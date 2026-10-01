/**
 * The hosts and paths a scan is allowed to follow, built from the seed URL,
 * `--include-host`, and `--exclude-path`.
 *
 * Scope matches `isSameDomain`: a host with its port. An `http -> https` upgrade
 * or a `www` redirect on the same host stays in scope, while a redirect to
 * another host or port does not — so a hostile site cannot bounce the crawl
 * somewhere the user never agreed to. A host is added to the scope by
 * `--include-host`; a path is removed from it by `--exclude-path`.
 */

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The host of a URL *including its port*, matching `isSameDomain`. A default
 * port is omitted by `URL.host`, so `http://x` and `https://x` stay the same
 * host across an upgrade, while `x:8080` is its own host.
 */
function hostOf(raw: string): string | null {
  try {
    return normalizeHost(new URL(raw).host);
  } catch {
    return null;
  }
}

/** `www.example.com` and `example.com` are the same site. */
function bareHost(host: string): string {
  return host.replace(/^www\./, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A path pattern matches a pathname as a prefix (`/admin` skips `/admin` and
 * `/admin/users`) unless it contains a star, in which case it is a glob anchored
 * to the whole pathname (`*.pdf`, `/orders/*`).
 */
function matchesPath(pattern: string, pathname: string): boolean {
  const pat = pattern.startsWith('/') ? pattern : `/${pattern}`;
  if (pat.includes('*')) {
    const regex = new RegExp(`^${pat.split('*').map(escapeRegExp).join('.*')}$`);
    return regex.test(pathname);
  }
  const trimmed = pat.endsWith('/') ? pat.replace(/\/+$/, '') : pat;
  if (trimmed === '') return false;
  return pathname === trimmed || pathname.startsWith(`${trimmed}/`);
}

export class ScanScope {
  private readonly hosts = new Set<string>();
  private readonly excludePaths: string[];

  constructor(
    seedUrl: string,
    includeHosts: readonly string[] = [],
    excludePaths: readonly string[] = [],
  ) {
    const seedHost = hostOf(seedUrl);
    if (seedHost) this.addHost(seedHost);
    for (const raw of includeHosts) {
      const value = raw.trim();
      if (!value) continue;
      // Accept a bare host, a host:port, or a full URL. The port matters: pass
      // `api.example.com:8443` to include a host on a non-default port.
      const host = hostOf(value.includes('://') ? value : `http://${value}`);
      if (host) this.addHost(host);
    }
    this.excludePaths = excludePaths.map((path) => path.trim()).filter(Boolean);
  }

  private addHost(host: string): void {
    this.hosts.add(host);
    this.hosts.add(bareHost(host));
  }

  /** True when the URL's host:port is the seed's or an included one (www-insensitive). */
  allowsHost(url: string): boolean {
    const host = hostOf(url);
    if (!host) return false;
    return this.hosts.has(host) || this.hosts.has(bareHost(host));
  }

  /** True when the URL's path is not matched by any `--exclude-path` pattern. */
  allowsPath(url: string): boolean {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return true;
    }
    return !this.excludePaths.some((pattern) => matchesPath(pattern, pathname));
  }

  /** A URL the crawl may follow: in-scope host and not an excluded path. */
  allows(url: string): boolean {
    return this.allowsHost(url) && this.allowsPath(url);
  }

  /** The hosts in scope, for a log line or a hint. */
  hostList(): string[] {
    return [...this.hosts].sort();
  }
}
