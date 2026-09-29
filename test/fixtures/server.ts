/**
 * Local fixture site + mock API used by tests and examples. Plain node:http so
 * it carries no dependencies and can be started programmatically from tests or
 * standalone via `npm run test:server`.
 *
 * Two listeners are started:
 *  - the site itself (default :4599)
 *  - a "third-party" origin (default site+1) that serves a CORS-enabled
 *    /collect beacon so cross-origin capture can be tested.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'site');

export interface FixtureServerHandle {
  url: string;
  port: number;
  thirdPartyUrl: string;
  thirdPartyPort: number;
  close: () => Promise<void>;
}

export interface FixtureServerOptions {
  port?: number;
  thirdPartyPort?: number;
  host?: string;
}

const DEFAULT_USER = 'demo@example.com';
const DEFAULT_PASS = 'hunter2';

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Powered-By': 'Express',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function text(res: ServerResponse, status: number, body: string): void {
  send(res, status, 'text/plain; charset=utf-8', body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = rest.join('=');
  }
  return out;
}

function sessionUserId(cookies: Record<string, string>): string | null {
  const raw = cookies['connect.sid'];
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw.replace(/^s:/, ''), 'base64url').toString('utf8');
    return decoded.startsWith('user:') ? decoded.slice(5) : null;
  } catch {
    return null;
  }
}

function page(res: ServerResponse, html: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Powered-By': 'Express',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(html);
}

async function serveSiteFile(res: ServerResponse, file: string): Promise<void> {
  try {
    const html = await readFile(join(SITE_DIR, file), 'utf8');
    // Allow the site to inject its own origin for same-origin fetch calls.
    page(res, html);
  } catch {
    send(res, 500, 'text/plain; charset=utf-8', `missing fixture ${file}`);
  }
}

/** Start the fixture site and its third-party companion. */
export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4599;
  const thirdPartyPort = options.thirdPartyPort ?? port + 1;

  let thirdPartyOrigin = `http://${host}:${thirdPartyPort}`;

  const siteServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;
    const cookies = parseCookies(req.headers.cookie);
    const userId = sessionUserId(cookies);

    try {
      // --- robots.txt -------------------------------------------------------
      if (path === '/robots.txt') {
        return text(res, 200, 'User-agent: *\nDisallow: /admin\n');
      }

      // --- API --------------------------------------------------------------
      if (path === '/api/login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          username?: string;
          password?: string;
        };
        const expectedUser = process.env.FIXTURE_USER ?? DEFAULT_USER;
        const expectedPass = process.env.FIXTURE_PASS ?? DEFAULT_PASS;
        if (body.username !== expectedUser || body.password !== expectedPass) {
          return json(res, 401, { error: 'invalid_credentials' });
        }
        const sid = 's:' + Buffer.from(`user:${body.username}`).toString('base64url');
        res.setHeader('Set-Cookie', `connect.sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        return json(res, 200, { ok: true, token: 'fixture-token-123', user: { username: body.username } });
      }

      if (path === '/api/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', 'connect.sid=; Path=/; HttpOnly; Max-Age=0');
        return json(res, 200, { ok: true });
      }

      if (path === '/api/user' && req.method === 'GET') {
        if (!userId) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, {
          id: '9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
          username: userId,
          email: userId,
          roles: ['customer', 'beta'],
          avatarUrl: 'https://cdn.example.com/avatars/9b2f4a3e.png',
        });
      }

      if (path === '/api/orders' && req.method === 'GET') {
        if (!userId) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, {
          orders: [
            { id: 1042, total: 59.9, status: 'shipped', items: [{ sku: 'W-1', qty: 2, price: 19.95 }] },
            { id: 1043, total: 12.5, status: 'processing', items: [{ sku: 'G-7', qty: 1, price: 12.5 }] },
          ],
          total: 2,
        });
      }

      const orderById = /^\/api\/orders\/(\d+)$/.exec(path);
      if (orderById && req.method === 'GET') {
        if (!userId) return json(res, 401, { error: 'unauthorized' });
        const id = Number(orderById[1]);
        return json(res, 200, {
          id,
          total: 59.9,
          status: 'shipped',
          items: [{ sku: 'W-1', qty: 2, price: 19.95 }],
        });
      }

      if (path === '/api/products' && req.method === 'GET') {
        const pageNum = Number(url.searchParams.get('page') ?? '1');
        const products = Array.from({ length: 3 }, (_, i) => ({
          id: (pageNum - 1) * 3 + i + 1,
          name: `Widget ${(pageNum - 1) * 3 + i + 1}`,
          price: 9.99 + i,
          tags: ['tools', i % 2 === 0 ? 'sale' : 'new'],
        }));
        return json(res, 200, { page: pageNum, pageSize: 3, hasMore: pageNum < 3, products });
      }

      if (path === '/api/search' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { q?: string };
        return json(res, 200, {
          query: body.q ?? '',
          total: 1,
          results: [{ id: 7, name: `Result for ${body.q ?? ''}`, price: 4.5 }],
        });
      }

      if (path === '/api/collect' && req.method === 'POST') {
        return json(res, 204, null);
      }

      if (path === '/api/graphql' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          query?: string;
          operationName?: string;
        };
        const query = body.query ?? '';
        if (query.includes('__schema')) {
          return json(res, 200, { data: { __schema: { queryType: { name: 'Query' } } } });
        }
        if (query.includes('products')) {
          return json(res, 200, { data: { products: [{ id: 1, name: 'Widget 1', price: 9.99 }] } });
        }
        return json(res, 200, { data: { viewer: { id: 'user-1', name: 'Demo' } } });
      }

      // --- Pages ------------------------------------------------------------
      if (path === '/dashboard') {
        if (!userId) {
          res.writeHead(302, { Location: '/login', 'X-Powered-By': 'Express' });
          return res.end();
        }
        return serveSiteFile(res, 'dashboard.html');
      }

      if (path === '/external.html') {
        const html = await readFile(join(SITE_DIR, 'external.html'), 'utf8');
        return page(res, html.replaceAll('__THIRD_PARTY_BASE__', thirdPartyOrigin));
      }

      const staticMap: Record<string, string> = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/products': 'products.html',
        '/products.html': 'products.html',
        '/login': 'login.html',
        '/login.html': 'login.html',
        '/about.html': 'about.html',
        '/graphql': 'graphql.html',
        '/graphql.html': 'graphql.html',
        '/admin': 'admin.html',
        '/admin.html': 'admin.html',
      };
      const file = staticMap[path];
      if (file && req.method === 'GET') return serveSiteFile(res, file);

      return json(res, 404, { error: 'not_found', path });
    } catch (err) {
      return json(res, 500, { error: 'fixture_error', detail: String(err) });
    }
  });

  const thirdPartyServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', thirdPartyOrigin).pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (path === '/collect' && req.method === 'POST') {
      await readBody(req);
      res.writeHead(204, { ...cors, 'X-Powered-By': 'Express' });
      return res.end();
    }
    if (path === '/sdk.js' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/javascript', 'X-Powered-By': 'Express' });
      return res.end('window.partnerSdk = { track: function () {} };');
    }
    if (path === '/sdk/config.json' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'X-Powered-By': 'Express' });
      return res.end(JSON.stringify({ partner: 'fixture-widgets', theme: { accent: '#0ea5e9' } }));
    }
    res.writeHead(404, cors);
    res.end();
  });

  const [siteAddress, thirdPartyAddress] = await Promise.all([
    listen(siteServer, port, host),
    listen(thirdPartyServer, thirdPartyPort, host),
  ]);
  const actualPort = siteAddress.port;
  const actualThirdPartyPort = thirdPartyAddress.port;
  thirdPartyOrigin = `http://${host}:${actualThirdPartyPort}`;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    thirdPartyUrl: thirdPartyOrigin,
    thirdPartyPort: actualThirdPartyPort,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => siteServer.close(() => r())),
        new Promise<void>((r) => thirdPartyServer.close(() => r())),
      ]);
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address() as AddressInfo));
  });
}

/** Standalone entrypoint: `tsx test/fixtures/server.ts --port 4599` */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argPort = process.argv.indexOf('--port');
  const port =
    (argPort > -1 ? Number(process.argv[argPort + 1]) : undefined) ??
    (process.env.PORT ? Number(process.env.PORT) : 4599);
  // Bind to all interfaces when a platform-injected PORT is present so the
  // fixture can be served as a preview; local runs stay loopback-only.
  const host = process.env.FIXTURE_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  startFixtureServer({ port, host })
    .then((handle) => {
      console.log(`fixture site:  ${handle.url}`);
      console.log(`third-party:   ${handle.thirdPartyUrl}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
