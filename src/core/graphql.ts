/**
 * GraphQL request detection and document scanning.
 *
 * GraphQL rides on ordinary HTTP, so a captured call is recognized by what it
 * carries rather than by its URL: a JSON body with a `query` document (POST),
 * an `application/graphql` body, a `query` search parameter (GET), or the
 * `operationName` of an automatic persisted query. Nothing here executes or
 * replays a request — the document text is only tokenized to read the operation
 * definitions, their top-level selection sets and argument names, and whether
 * the schema introspection fields were selected.
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
      const existing = operations.get(key);
      // Union the observations, so a field or argument seen in any sample is kept.
      operations.set(key, existing ? mergeOperation(existing, operation) : operation);
    }
  }

  if (!found) return null;
  return { introspection, operations: sortOperations([...operations.values()]) };
}

/** Union two observations of one operation, so no selected field is dropped. */
function mergeOperation(a: GraphQLOperation, b: GraphQLOperation): GraphQLOperation {
  const selections = unionSorted(a.selections, b.selections);
  const args = unionSorted(a.arguments, b.arguments);
  return {
    ...a,
    ...(selections.length ? { selections } : {}),
    ...(args.length ? { arguments: args } : {}),
  };
}

function unionSorted(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])].sort();
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
      operations.push(withSelections({ name, type }, readSelectionSet(tokens, selection)));
      // Skip the whole operation so fields inside it are never read as definitions.
      i = skipSelectionSet(tokens, selection);
      continue;
    }

    if (token.kind === 'punct' && token.value === '{') {
      // Anonymous query shorthand: `{ products { id } }`.
      operations.push(withSelections({ name: null, type: 'query' }, readSelectionSet(tokens, i)));
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

interface ReadSelectionSet {
  selections: string[];
  arguments: string[];
}

/** Attach the field and argument names a document revealed, when it had any. */
function withSelections(
  operation: GraphQLOperation,
  read: ReadSelectionSet,
): GraphQLOperation {
  return {
    ...operation,
    ...(read.selections.length ? { selections: read.selections } : {}),
    ...(read.arguments.length ? { arguments: read.arguments } : {}),
  };
}

/**
 * Read the fields selected at the top level of the selection set opened at
 * `openBrace`, plus the argument names passed to those fields. Nested selection
 * sets, fragment spreads, inline fragments, and directive arguments are skipped
 * so only what this operation selects directly is recorded. Names are sorted so
 * the result does not depend on how the document happened to be written.
 */
function readSelectionSet(tokens: Token[], openBrace: number): ReadSelectionSet {
  const selections = new Set<string>();
  const args = new Set<string>();
  const end = matchingClose(tokens, openBrace);
  let i = openBrace + 1;

  while (i < end) {
    const token = tokens[i]!;

    if (token.kind === 'punct') {
      if (token.value === '@') {
        // A directive on the preceding field: skip its name and optional args.
        i += 1;
        if (tokens[i]?.kind === 'name') i += 1;
        if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '(') i = skipBalanced(tokens, i);
        continue;
      }
      if (token.value === '...') {
        i = skipFragment(tokens, i);
        continue;
      }
      if (token.value === '(' || token.value === '{') {
        i = skipBalanced(tokens, i);
        continue;
      }
      i += 1;
      continue;
    }

    if (token.kind === 'string') {
      i += 1;
      continue;
    }

    // A field: `name`, or `alias: name`, with optional arguments.
    let field = token.value;
    i += 1;
    if (tokens[i]?.kind === 'punct' && tokens[i]!.value === ':') {
      const aliased = tokens[i + 1];
      if (aliased?.kind === 'name') {
        field = aliased.value;
        i += 2;
      }
    }
    selections.add(field);
    if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '(') {
      collectArgumentNames(tokens, i, args);
      i = skipBalanced(tokens, i);
    }
  }

  return { selections: [...selections].sort(), arguments: [...args].sort() };
}

/** Skip a fragment spread or inline fragment, including any selection set. */
function skipFragment(tokens: Token[], at: number): number {
  let i = at + 1; // past the `...`
  if (tokens[i]?.kind === 'name' && tokens[i]!.value === 'on') {
    i += 1;
    if (tokens[i]?.kind === 'name') i += 1; // the type condition
  } else if (tokens[i]?.kind === 'name') {
    i += 1; // the fragment name
  }
  while (tokens[i]?.kind === 'punct' && tokens[i]!.value === '@') {
    i += 1;
    if (tokens[i]?.kind === 'name') i += 1;
    if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '(') i = skipBalanced(tokens, i);
  }
  if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '{') i = skipBalanced(tokens, i);
  return i;
}

/**
 * Collect the argument names (`name:` pairs) of a call's argument list. Only
 * pairs at the top level of the list count, so object literals and nested
 * input objects are not mistaken for arguments.
 */
function collectArgumentNames(tokens: Token[], openParen: number, args: Set<string>): void {
  const end = matchingClose(tokens, openParen);
  let depth = 0;
  for (let i = openParen + 1; i < end; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct') continue;
    if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
    else if (token.value === ')' || token.value === ']' || token.value === '}')
      depth = Math.max(0, depth - 1);
    else if (token.value === ':' && depth === 0) {
      const previous = tokens[i - 1];
      if (previous?.kind === 'name') args.add(previous.value);
    }
  }
}

/** Index of the bracket that closes the one opened at `openIndex`. */
function matchingClose(tokens: Token[], openIndex: number): number {
  const open = tokens[openIndex]!.value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct') continue;
    if (token.value === open) depth += 1;
    else if (token.value === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length;
}

/** Index just past the bracket that closes the one opened at `openIndex`. */
function skipBalanced(tokens: Token[], openIndex: number): number {
  const close = matchingClose(tokens, openIndex);
  return close < tokens.length ? close + 1 : tokens.length;
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
