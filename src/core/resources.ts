/**
 * Cluster endpoints into resources for a coverage view.
 *
 * `/api/orders`, `/api/orders/{id}`, and `/api/orders/{id}/items` all sit under
 * the collection root `/api/orders`, so grouping them by that root turns the
 * flat endpoint list into a per-resource view. The verbs observed on each path
 * are kept, and the conventional ones that are absent are reported — but only
 * for a resource that exposes an item path, so an action endpoint such as
 * `POST /api/login` is not asked for a `GET` it was never meant to have.
 */

import type { Category, Endpoint, Resource, ResourceEndpoint } from '../types.js';

/** Verbs a collection root is expected to support, by REST convention. */
const COLLECTION_VERBS = ['GET', 'POST'];
/** Verbs an item path (one ending in a `{param}`) is expected to support. */
const ITEM_VERBS = ['GET', 'PUT', 'PATCH', 'DELETE'];
const PARAM_SEGMENT_RE = /^\{.+\}$/;

/** Group endpoints by collection root, each with its paths and missing verbs. */
export function groupResources(endpoints: readonly Endpoint[]): Resource[] {
  const groups = new Map<string, { categories: Set<Category>; paths: Map<string, Set<string>> }>();

  for (const endpoint of endpoints) {
    const root = collectionRoot(endpoint.urlPattern);
    let group = groups.get(root);
    if (!group) {
      group = { categories: new Set(), paths: new Map() };
      groups.set(root, group);
    }
    group.categories.add(endpoint.category);
    const methods = group.paths.get(endpoint.urlPattern) ?? new Set<string>();
    methods.add(endpoint.method.toUpperCase());
    group.paths.set(endpoint.urlPattern, methods);
  }

  const resources: Resource[] = [];
  for (const [root, group] of groups) {
    // Only a resource with an item path is a CRUD collection worth auditing.
    const crud = [...group.paths.keys()].some(hasParam);
    const paths: ResourceEndpoint[] = [...group.paths.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, methods]) => {
        const observed = [...methods].sort();
        return {
          path,
          methods: observed,
          missingMethods: crud ? missingMethods(path, observed) : [],
        };
      });
    resources.push({ path: root, categories: [...group.categories].sort(), paths });
  }

  resources.sort((a, b) => a.path.localeCompare(b.path));
  return resources;
}

/** The collection root a path belongs to (everything before its first param). */
function collectionRoot(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean);
  const paramAt = segments.findIndex((segment) => PARAM_SEGMENT_RE.test(segment));
  // No parameter, or the path starts with one: the path is its own root.
  if (paramAt <= 0) return pattern || '/';
  return '/' + segments.slice(0, paramAt).join('/');
}

function hasParam(path: string): boolean {
  return path.split('/').some((segment) => PARAM_SEGMENT_RE.test(segment));
}

function isItem(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && PARAM_SEGMENT_RE.test(last);
}

function missingMethods(path: string, observed: readonly string[]): string[] {
  const expected = isItem(path) ? ITEM_VERBS : COLLECTION_VERBS;
  const seen = new Set(observed);
  return expected.filter((verb) => !seen.has(verb));
}
