/**
 * GraphQL request detection and document scanning.
 *
 * GraphQL rides on ordinary HTTP, so a captured call is recognized by what it
 * carries rather than by its URL: a JSON body with a `query` document (POST),
 * an `application/graphql` body, a `query` search parameter (GET), or the
 * `operationName` of an automatic persisted query. Nothing here executes or
 * replays a request — the document text is only tokenized to read the operation
 * definitions and check whether the schema introspection fields were selected.
 */

import type {
  CapturedCall,
  GraphQLInfo,
  GraphQLOperation,
  GraphQLOperationType,
} from '../types.js';

const OPERATION_KEYWORDS = new Set<string>(['query', 'mutation', 'subscription']);
/** Fields that only exist to introspect a schema (not `__typename`, which is ordinary). */
const INTROSPECTION_FIELDS = new Set<string>(['__schema', '__type']);
/** The conventional operation name of the standard introspection query. */
const INTROSPECTION_OPERATION = 'IntrospectionQuery';
const GRAPHQL_PATH_RE = /(^|\/)graphql\/?$/i;

type TokenKind = 'name' | 'punct' | 'string';

interface Token {
  kind: TokenKind;
  value: string;
}

interface GraphQLRequest {
  /** The operation document, when the request carried one. */
  query: string | null;
  operationName: string | null;
}

export interface ParsedGraphQLDocument {
  operations: GraphQLOperation[];
  introspection: boolean;
}

/** Detect GraphQL on a single captured call; `null` when it is not GraphQL. */
export function analyzeGraphQL(call: CapturedCall): GraphQLInfo | null {
  const request = extractRequest(call);
  return request ? buildInfo(request) : null;
}

/** Fold per-call detections into one endpoint-level summary. */
export function mergeGraphQL(infos: Iterable<GraphQLInfo | null>): GraphQLInfo | null {
  const operations = new Map<string, GraphQLOperation>();
  let introspection = false;
  let found = false;

  for (const info of infos) {
    if (!info) continue;
    found = true;
    introspection = introspection || info.introspection;
    for (const operation of info.operations) {
      const key = `${operation.type}:${operation.name ?? ''}`;
      if (!operations.has(key)) operations.set(key, operation);
    }
  }

  if (!found) return null;
  return { introspection, operations: sortOperations([...operations.values()]) };
}

/**
 * Read the operation definitions and introspection fields out of a GraphQL
 * document. A small tokenizer is used rather than a regex so that keywords and
 * fields inside strings, comments, and nested selection sets cannot be mistaken
 * for top-level operations.
 */
export function parseGraphQLDocument(query: string): ParsedGraphQLDocument {
  const tokens = tokenize(query);

  let introspection = false;
  for (const token of tokens) {
    if (token.kind === 'name' && INTROSPECTION_FIELDS.has(token.value)) introspection = true;
  }

  const operations: GraphQLOperation[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;

    if (token.kind === 'name' && OPERATION_KEYWORDS.has(token.value)) {
      const type = token.value as GraphQLOperationType;
      let name: string | null = null;
      let cursor = i + 1;
      if (tokens[cursor]?.kind === 'name') {
        name = tokens[cursor]!.value;
        cursor += 1;
      }
      const selection = findSelectionSet(tokens, cursor);
      if (selection === -1) {
        i = cursor;
        continue;
      }
      operations.push({ name, type });
      // Skip the whole operation so fields inside it are never read as definitions.
      i = skipSelectionSet(tokens, selection);
      continue;
    }

    if (token.kind === 'punct' && token.value === '{') {
      // Anonymous query shorthand: `{ products { id } }`.
      operations.push({ name: null, type: 'query' });
      i = skipSelectionSet(tokens, i);
      continue;
    }

    if (token.kind === 'name' && token.value === 'fragment') {
      const selection = findSelectionSet(tokens, i + 1);
      i = selection === -1 ? i + 1 : skipSelectionSet(tokens, selection);
      continue;
    }

    i += 1;
  }

  return { operations, introspection };
}

function extractRequest(call: CapturedCall): GraphQLRequest | null {
  const graphqlPath = GRAPHQL_PATH_RE.test(safePathname(call.url));
  const contentType = (call.requestHeaders['content-type'] ?? '').toLowerCase();
  const body = call.requestBodySample;

  if (body) {
    if (contentType.includes('application/graphql')) {
      const query = body.trim();
      return looksLikeGraphQLDocument(query) ? { query, operationName: null } : null;
    }

    const parsed = parseJsonObject(body);
    if (parsed) {
      const operationName = asString(parsed['operationName']);
      const query = asString(parsed['query']);
      if (query && looksLikeGraphQLDocument(query)) return { query, operationName };

      // An automatic persisted query sends an operation name and a hash instead
      // of the document; without one of those signals a lone `operationName` is
      // too weak to call GraphQL.
      if (operationName && (isPersistedQuery(parsed['extensions']) || graphqlPath)) {
        return { query: null, operationName };
      }
    }
  }

  const params = urlSearchParams(call.url);
  if (params) {
    const query = params.get('query');
    if (query && looksLikeGraphQLDocument(query)) {
      return { query, operationName: params.get('operationName') };
    }
    const operationName = params.get('operationName');
    if (operationName && graphqlPath) return { query: null, operationName };
  }

  return null;
}

function buildInfo(request: GraphQLRequest): GraphQLInfo {
  if (!request.query) {
    return { introspection: false, operations: [{ name: request.operationName, type: 'unknown' }] };
  }

  const parsed = parseGraphQLDocument(request.query);
  const operations = [...parsed.operations];
  if (request.operationName && !operations.some((op) => op.name === request.operationName)) {
    // The document did not declare the operation the caller named, so attribute
    // the call to it anyway rather than dropping the name.
    operations.push({ name: request.operationName, type: 'unknown' });
  }

  const introspection =
    parsed.introspection || request.operationName === INTROSPECTION_OPERATION;
  return { introspection, operations: sortOperations(dedupeOperations(operations)) };
}

/** True when a string is plausibly a GraphQL document rather than arbitrary text. */
function looksLikeGraphQLDocument(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') return false;
  const first = tokenize(trimmed)[0];
  if (!first) return false;
  if (first.kind === 'punct' && first.value === '{') return true;
  if (first.kind !== 'name') return false;
  return OPERATION_KEYWORDS.has(first.value) || first.value === 'fragment';
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        i += 3;
        while (i < source.length && !source.startsWith('"""', i)) i += 1;
        i += 3;
      } else {
        i += 1;
        while (i < source.length && source[i] !== '"') {
          if (source[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
      }
      tokens.push({ kind: 'string', value: '' });
      continue;
    }

    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }

    if (/[_A-Za-z]/.test(ch)) {
      const start = i;
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i]!)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
      continue;
    }

    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

/** Index of the `{` that opens a definition's selection set, or -1. */
function findSelectionSet(tokens: Token[], start: number): number {
  let parens = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct') continue;
    if (token.value === '(') parens += 1;
    else if (token.value === ')') parens = Math.max(0, parens - 1);
    else if (token.value === '{' && parens === 0) return i;
    else if (token.value === '}' && parens === 0) return -1;
  }
  return -1;
}

/** Index just past the selection set opened at `openBrace`. */
function skipSelectionSet(tokens: Token[], openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct') continue;
    if (token.value === '{') depth += 1;
    else if (token.value === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

function dedupeOperations(operations: GraphQLOperation[]): GraphQLOperation[] {
  const seen = new Set<string>();
  const out: GraphQLOperation[] = [];
  for (const operation of operations) {
    const key = `${operation.type}:${operation.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(operation);
  }
  return out;
}

function sortOperations(operations: GraphQLOperation[]): GraphQLOperation[] {
  return operations.sort(
    (a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.type.localeCompare(b.type),
  );
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPersistedQuery(extensions: unknown): boolean {
  if (extensions === null || typeof extensions !== 'object') return false;
  const persisted = (extensions as Record<string, unknown>)['persistedQuery'];
  return persisted !== null && typeof persisted === 'object';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function safePathname(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return '';
  }
}

function urlSearchParams(raw: string): URLSearchParams | null {
  try {
    return new URL(raw).searchParams;
  } catch {
    return null;
  }
}
