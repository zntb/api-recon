/**
 * Dashboard reporter — a standalone, interactive HTML page.
 *
 * Unlike `report.html` (the printable rendering of the Markdown report, and the
 * source PDF is printed from), this file is meant to be *used*: the report is
 * embedded as JSON and a small script renders it into a table you can search,
 * filter, sort, and expand.
 *
 * Everything is inlined — no CDN, no fonts, no fetch — so the file works from
 * `file://`, from an artifact upload, or from an air-gapped machine. All scanned
 * strings reach the DOM through `textContent`, never `innerHTML`, so a site
 * cannot inject markup into its own report.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconReport } from '../types.js';
import { FORMAT_FILENAMES } from './json.js';

const STYLE = `
  :root { color-scheme: light; --line: #e3e7ee; --muted: #5b6675; --ink: #1c2430; }
  * { box-sizing: border-box; }
  /* The hidden attribute has to beat the component rules below that set an
     explicit display, or hiding an element from script silently does nothing. */
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 2rem 1.5rem 4rem;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f6f7f9; color: var(--ink); line-height: 1.5;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header.top { display: flex; flex-wrap: wrap; gap: 1rem 2rem; align-items: flex-end;
    justify-content: space-between; margin-bottom: 1.25rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -0.02em; }
  .seed { margin: 0; color: var(--muted); font-size: .9rem; word-break: break-all; }
  .seed a { color: inherit; }
  dl.meta { display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; margin: 0; font-size: .82rem;
    color: var(--muted); }
  dl.meta div { display: flex; gap: .35rem; }
  dl.meta dt { margin: 0; }
  dl.meta dd { margin: 0; color: var(--ink); font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: .75rem; margin-bottom: 1.25rem; }
  .tile { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: .7rem .85rem; }
  .tile .n { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
  .tile .l { font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .tile.warn .n { color: #b42318; }
  .tile.good .n { color: #027a48; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(16,24,40,.04); overflow: hidden; }
  .controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center;
    padding: .85rem; border-bottom: 1px solid var(--line); background: #fbfcfe; }
  input[type=search], select { font: inherit; font-size: .87rem; padding: .4rem .55rem;
    border: 1px solid #cbd3df; border-radius: 7px; background: #fff; color: inherit; }
  input[type=search] { flex: 1 1 240px; min-width: 180px; }
  label.check { display: inline-flex; align-items: center; gap: .35rem; font-size: .84rem;
    color: var(--muted); user-select: none; }
  button { font: inherit; font-size: .84rem; padding: .4rem .7rem; border-radius: 7px;
    border: 1px solid #cbd3df; background: #fff; color: inherit; cursor: pointer; }
  button:hover { background: #f2f5fa; }
  .count { margin-left: auto; font-size: .8rem; color: var(--muted); white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: .86rem; }
  th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  th { background: #f4f6fa; font-weight: 600; white-space: nowrap; position: sticky; top: 0; z-index: 1; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { background: #e9eef7; }
  th .arrow { color: var(--muted); font-size: .7rem; margin-left: .25rem; }
  tbody tr.row { cursor: pointer; }
  tbody tr.row:hover td { background: #f7f9fd; }
  tbody tr.row:focus-visible { outline: 2px solid #4f6ef7; outline-offset: -2px; }
  tbody tr.row.open td { background: #f2f5fd; }
  /* Removed endpoints keep the loudest treatment: gone from this scan is the
     change most likely to break something. */
  tbody tr.row.removed td { background: #fff7f6; }
  tbody tr.row.removed:hover td, tbody tr.row.removed.open td { background: #fdeceb; }
  tbody tr.row.removed td.path { text-decoration: line-through; opacity: .75; }
  td.path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .method { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .76rem; font-weight: 700; letter-spacing: .02em; padding: .1rem .4rem;
    border-radius: 5px; background: #eef1f6; white-space: nowrap; }
  .m-GET { color: #0552b5; background: #e8f0fe; }
  .m-POST { color: #027a48; background: #e7f6ef; }
  .m-PUT, .m-PATCH { color: #b54708; background: #fdf2e4; }
  .m-DELETE { color: #b42318; background: #fdeceb; }
  .badge { font-size: .74rem; padding: .1rem .45rem; border-radius: 99px;
    background: #eef1f6; color: #404a5c; white-space: nowrap; }
  .badge.breaking { background: #fdeceb; color: #b42318; font-weight: 600; }
  .badge.added { background: #e7f6ef; color: #027a48; }
  .badge.removed { background: #fdeceb; color: #b42318; }
  .badge.changed { background: #fdf2e4; color: #b54708; }
  .status-ok { color: #027a48; }
  .status-warn { color: #b54708; }
  .status-bad { color: #b42318; }
  tr.details > td { background: #fbfcfe; padding: 1rem 1.1rem 1.25rem; }
  .blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
  .block h4 { margin: 0 0 .4rem; font-size: .72rem; text-transform: uppercase;
    letter-spacing: .07em; color: var(--muted); }
  .block.full { grid-column: 1 / -1; }
  .block ul { margin: 0; padding-left: 1.1rem; }
  .block li { margin: .1rem 0; word-break: break-all; }
  pre { margin: 0; background: #0f172a; color: #e2e8f0; padding: .7rem .8rem;
    border-radius: 7px; overflow-x: auto; font-size: .76rem; line-height: 1.4;
    max-height: 22rem; }
  .hint { color: var(--muted); font-size: .8rem; margin: 0; }
  .empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; margin: 0; }
  noscript .panel { display: block; padding: 1.25rem; }
`;

/** Client script. Deliberately avoids template literals: this is a `...` string. */
const SCRIPT = `
(function () {
  'use strict';

  var payload = document.getElementById('report-data');
  var data = JSON.parse(payload.textContent);
  var endpoints = data.endpoints || [];
  var diff = data.diff || null;
  var changeById = {};
  if (diff) {
    (diff.changes || []).forEach(function (change) { changeById[change.id] = change; });
  }

  // A removed endpoint does not exist in this scan, so the report has no row for
  // it — without this it would only ever be a number in the summary, never
  // something you can look at. Rebuild a minimal row from the diff so the most
  // consequential change is visible, filterable, and highlighted.
  var REMOVED = '__removed';
  var removed = [];
  if (diff) {
    (diff.changes || []).forEach(function (change) {
      if (change.kind !== 'removed') return;
      var split = change.id.indexOf(' ');
      removed.push({
        id: change.id,
        method: split === -1 ? '—' : change.id.slice(0, split),
        urlPattern: split === -1 ? change.id : change.id.slice(split + 1),
        category: REMOVED,
        count: null,
        statusCodes: [],
        origins: [],
        mimeTypes: [],
        pathParams: [],
        queryParams: [],
        triggeredBy: [],
        requestHeaders: {},
        responseHeaders: {},
        requestBodySample: null,
        responseBodySample: null,
        requestBodySchema: null,
        responseSchema: null,
        removed: true
      });
    });
  }
  // WebSocket connections are not endpoints, but they belong in the same
  // searchable, sortable table, so each one becomes a pseudo-row: the URL is
  // the path, the frame count is the call count, and the frames replace the
  // request/response detail.
  var sockets = (data.webSockets || []).map(function (ws) {
    return {
      id: 'WS ' + ws.url,
      method: 'WS',
      urlPattern: ws.url,
      category: 'websocket',
      count: ws.frameCount,
      statusCodes: [],
      origins: ws.origins || [],
      mimeTypes: [],
      pathParams: [],
      queryParams: [],
      triggeredBy: ws.triggeredBy ? [ws.triggeredBy] : [],
      requestHeaders: {},
      responseHeaders: {},
      frames: ws.frames || [],
      sentCount: ws.sentCount,
      receivedCount: ws.receivedCount,
      framesTruncated: ws.framesTruncated,
      sentSchema: ws.sentSchema || null,
      receivedSchema: ws.receivedSchema || null,
      websocket: true
    };
  });
  var allRows = endpoints.concat(removed).concat(sockets);

  var state = { q: '', category: 'all', method: 'all', status: 'all', breaking: false, changed: false, sort: null, dir: 1 };
  var expanded = {};

  var statsEl = document.getElementById('stats');
  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var qEl = document.getElementById('q');
  var categoryEl = document.getElementById('category');
  var methodEl = document.getElementById('method');
  var statusEl = document.getElementById('status');
  var breakingEl = document.getElementById('breaking');
  var changedEl = document.getElementById('changed');
  var resetEl = document.getElementById('reset');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function unique(values) {
    var seen = [];
    values.forEach(function (value) {
      if (value !== undefined && value !== null && seen.indexOf(value) === -1) seen.push(value);
    });
    return seen.sort(function (a, b) {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    });
  }

  function option(value, label) {
    var node = el('option', null, label === undefined ? value : label);
    node.value = String(value);
    return node;
  }

  // ---- summary tiles -------------------------------------------------------
  function tile(label, value, tone) {
    var box = el('div', 'tile' + (tone ? ' ' + tone : ''));
    box.appendChild(el('div', 'n', value));
    box.appendChild(el('div', 'l', label));
    return box;
  }

  function renderStats() {
    statsEl.textContent = '';
    var categories = unique(endpoints.concat(sockets).map(function (e) { return e.category; }));
    statsEl.appendChild(tile('Endpoints', endpoints.length));
    statsEl.appendChild(tile('Pages', (data.pages || []).length));
    statsEl.appendChild(tile('Technologies', (data.technologies || []).length));
    statsEl.appendChild(tile('Categories', categories.length));
    if (sockets.length) statsEl.appendChild(tile('WebSockets', sockets.length));
    if (diff) {
      statsEl.appendChild(tile('Added', diff.counts.added, diff.counts.added ? 'good' : ''));
      statsEl.appendChild(tile('Removed', diff.counts.removed, diff.counts.removed ? 'warn' : ''));
      statsEl.appendChild(tile('Changed', diff.counts.changed));
      statsEl.appendChild(tile('Breaking', diff.counts.breaking, diff.counts.breaking ? 'warn' : ''));
    }
  }

  // ---- filter controls -----------------------------------------------------
  // ---- resource coverage ---------------------------------------------------
  function renderResources() {
    var host = document.getElementById('resources');
    var resources = data.resources || [];
    if (!resources.length) { host.hidden = true; return; }
    host.appendChild(el('h2', null, 'Resource coverage'));
    resources.forEach(function (resource) {
      var block = el('div', 'block full');
      var head = resource.path;
      if ((resource.categories || []).length) head += ' · ' + resource.categories.join(', ');
      block.appendChild(el('h4', null, head));
      var list = el('ul');
      (resource.paths || []).forEach(function (p) {
        var line = p.path + ' — ' + ((p.methods || []).join(', ') || 'no calls');
        if ((p.missingMethods || []).length) line += ' · missing: ' + p.missingMethods.join(', ');
        list.appendChild(el('li', null, line));
      });
      block.appendChild(list);
      host.appendChild(block);
    });
  }

  // ---- findings ------------------------------------------------------------
  function renderFindings() {
    var host = document.getElementById('findings');
    var findings = data.findings || [];
    if (!findings.length) { host.hidden = true; return; }
    host.appendChild(el('h2', null, 'Findings & next steps'));
    findings.forEach(function (finding) {
      var block = el('div', 'block full');
      block.appendChild(el('h4', null, finding.title + ' · ' + finding.severity));
      var list = el('ul');
      var details = finding.details || [];
      if (details.length) {
        details.forEach(function (detail) { list.appendChild(el('li', null, detail)); });
      } else {
        (finding.endpoints || []).forEach(function (id) { list.appendChild(el('li', null, id)); });
      }
      block.appendChild(list);
      host.appendChild(block);
    });
  }

  function buildControls() {
    var categories = unique(endpoints.concat(sockets).map(function (e) { return e.category; }));
    var methods = unique(allRows.map(function (e) { return e.method; }));
    var statuses = unique(endpoints.reduce(function (all, e) {
      return all.concat(e.statusCodes || []);
    }, []));

    categoryEl.appendChild(option('all', 'All categories'));
    categories.forEach(function (c) { categoryEl.appendChild(option(c)); });
    if (removed.length) categoryEl.appendChild(option(REMOVED, 'Removed (baseline)'));

    methodEl.appendChild(option('all', 'All methods'));
    methods.forEach(function (m) { methodEl.appendChild(option(m)); });

    statusEl.appendChild(option('all', 'All statuses'));
    statuses.forEach(function (s) { statusEl.appendChild(option(s)); });

    if (!diff) {
      // Nothing to compare against, so the diff-only filters are meaningless.
      breakingEl.parentNode.hidden = true;
      changedEl.parentNode.hidden = true;
    }
  }

  // ---- filtering and sorting ----------------------------------------------
  function haystack(e) {
    return [
      e.id,
      e.method,
      e.urlPattern,
      e.category,
      (e.statusCodes || []).join(' '),
      (e.origins || []).join(' '),
      (e.mimeTypes || []).join(' '),
      (e.pathParams || []).join(' '),
      (e.triggeredBy || []).join(' '),
      (e.queryParams || []).map(function (p) { return p.name; }).join(' '),
      e.vendor ? e.vendor.name + ' ' + e.vendor.category + ' ' + (e.vendor.payloadKeys || []).join(' ') : '',
      e.cache ? [e.cache.control, e.cache.etag, e.cache.status].filter(Boolean).join(' ') : '',
      e.graphql ? 'graphql ' + (e.graphql.introspection ? 'introspection ' : '') + (e.graphql.operations || []).map(function (o) {
        return (o.name || 'anonymous') + ' ' + o.type;
      }).join(' ') : '',
      e.websocket ? 'websocket' : ''
    ].join(' ').toLowerCase();
  }

  function sortKey(e) {
    switch (state.sort) {
      case 'method': return e.method;
      case 'path': return e.urlPattern;
      case 'category': return e.category;
      case 'status': return (e.statusCodes && e.statusCodes.length) ? Math.min.apply(null, e.statusCodes) : -1;
      case 'count': return typeof e.count === 'number' ? e.count : -1;
      case 'time': return e.timing ? e.timing.p95 : -1;
      case 'pages': return e.removed ? -1 : (e.triggeredBy || []).length;
      case 'change': {
        var change = changeById[e.id];
        if (!change) return state.dir > 0 ? '~' : '';
        return (change.breaking ? '0' : '1') + change.kind;
      }
      default: return 0;
    }
  }

  function compare(a, b) {
    var left = sortKey(a);
    var right = sortKey(b);
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * state.dir;
    return String(left).localeCompare(String(right)) * state.dir;
  }

  function visible() {
    var query = state.q.trim().toLowerCase();
    var list = allRows.filter(function (e) {
      if (state.category !== 'all' && e.category !== state.category) return false;
      if (state.method !== 'all' && e.method !== state.method) return false;
      if (state.status !== 'all' && (e.statusCodes || []).indexOf(Number(state.status)) === -1) return false;
      var change = changeById[e.id];
      if (state.breaking && !(change && change.breaking)) return false;
      if (state.changed && !change) return false;
      if (query && haystack(e).indexOf(query) === -1) return false;
      return true;
    });
    if (state.sort) list = list.slice().sort(compare);
    return list;
  }

  // ---- detail panel --------------------------------------------------------
  function kv(label, values) {
    var block = el('section', 'block');
    block.appendChild(el('h4', null, label));
    if (!values.length) {
      block.appendChild(el('p', 'hint', 'none captured'));
      return block;
    }
    var list = el('ul');
    values.forEach(function (pair) {
      list.appendChild(el('li', null, pair));
    });
    block.appendChild(list);
    return block;
  }

  function pretty(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (err) {
      return text;
    }
  }

  function codeBlock(label, text, full) {
    var block = el('section', 'block' + (full ? ' full' : ''));
    block.appendChild(el('h4', null, label));
    var pre = el('pre');
    pre.textContent = text;
    block.appendChild(pre);
    return block;
  }

  // Mirrors describeGapReason() in core/schemaInference.ts; the dashboard is
  // self-contained, so it cannot import it.
  var GAP_NOTES = {
    'no-body': 'no body captured',
    'not-json': 'body was not JSON',
    'truncated': 'body was truncated',
    'binary': 'body is binary'
  };
  function gapNote(reason) {
    return GAP_NOTES[reason] || reason;
  }

  function headerList(headers) {
    return Object.keys(headers || {}).map(function (name) {
      return name + ': ' + headers[name];
    });
  }

  function fmtBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    var kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  }

  function cacheLines(cache) {
    var out = [];
    if (cache.control) out.push('cache-control: ' + cache.control);
    if (cache.etag) out.push('etag: ' + cache.etag);
    if (cache.lastModified) out.push('last-modified: ' + cache.lastModified);
    if (typeof cache.age === 'number') out.push('age: ' + cache.age + 's');
    if (cache.vary) out.push('vary: ' + cache.vary);
    if (cache.status) out.push('cache status: ' + cache.status);
    return out;
  }

  function details(e) {
    var row = el('tr', 'details');
    var cell = el('td');
    cell.colSpan = document.querySelectorAll('thead th').length;
    var blocks = el('div', 'blocks');
    var change = changeById[e.id];

    if (change) {
      var changeBlock = el('section', 'block full');
      changeBlock.appendChild(el('h4', null, 'Change since baseline'));
      var changeList = el('ul');
      changeList.appendChild(el('li', null, change.kind + (change.breaking ? ' (breaking)' : '')));
      (change.details || []).forEach(function (detail) {
        changeList.appendChild(el('li', null, detail));
      });
      changeBlock.appendChild(changeList);
      blocks.appendChild(changeBlock);
    }

    // A removed row is reconstructed from the diff alone, so there is nothing
    // else to show for it — say that instead of a wall of "none captured".
    if (e.removed) {
      var missing = el('section', 'block full');
      missing.appendChild(el('h4', null, 'Detail'));
      missing.appendChild(el('p', 'hint', 'This endpoint was captured by the baseline scan and not by this one, so there are no request or response samples to show.'));
      blocks.appendChild(missing);
      cell.appendChild(blocks);
      row.appendChild(cell);
      return row;
    }

    if (e.websocket) {
      blocks.appendChild(kv('Triggered by', e.triggeredBy || []));
      blocks.appendChild(kv('Frames', [e.count + ' total — ' + e.sentCount + ' sent, ' + e.receivedCount +
        ' received' + (e.framesTruncated ? ' (earlier frames not stored)' : '')]));
      var frameBlock = el('section', 'block full');
      frameBlock.appendChild(el('h4', null, 'Frames'));
      if (!(e.frames || []).length) {
        frameBlock.appendChild(el('p', 'hint', 'no frames were stored'));
      } else {
        var frameList = el('ul');
        (e.frames || []).forEach(function (frame) {
          frameList.appendChild(el('li', null,
            (frame.direction === 'sent' ? 'sent' : 'received') + ' · ' + frame.type + ' · ' + frame.size + ' B' +
            (frame.payloadSample ? ': ' + frame.payloadSample : ' (payload not stored)') +
            (frame.truncated ? ' …' : '')));
        });
        frameBlock.appendChild(frameList);
      }
      blocks.appendChild(frameBlock);
      if (e.sentSchema) blocks.appendChild(codeBlock('Sent schema', JSON.stringify(e.sentSchema, null, 2), true));
      if (e.sentSchemaReason) blocks.appendChild(el('p', 'hint', 'Sent schema not fully observed — ' + gapNote(e.sentSchemaReason)));
      if (e.receivedSchema) blocks.appendChild(codeBlock('Received schema', JSON.stringify(e.receivedSchema, null, 2), true));
      if (e.receivedSchemaReason) blocks.appendChild(el('p', 'hint', 'Received schema not fully observed — ' + gapNote(e.receivedSchemaReason)));
      cell.appendChild(blocks);
      row.appendChild(cell);
      return row;
    }

    if (e.vendor) {
      blocks.appendChild(kv('Vendor', [e.vendor.name + ' (' + e.vendor.category + ')']));
      blocks.appendChild(kv('Vendor payload keys', e.vendor.payloadKeys || []));
    }
    blocks.appendChild(kv('Origins', e.origins || []));
    blocks.appendChild(kv('Triggered by', e.triggeredBy || []));
    blocks.appendChild(kv('Path params', e.pathParams || []));
    blocks.appendChild(kv('Query params', (e.queryParams || []).map(function (p) {
      return p.name + ' = ' + (p.sampleValues || []).join(', ');
    })));
    blocks.appendChild(kv('MIME types', e.mimeTypes || []));
    if (e.timing) blocks.appendChild(kv('Timing (p50 / p95 / max)', [e.timing.p50 + ' ms / ' + e.timing.p95 + ' ms / ' + e.timing.max + ' ms']));
    if (e.requestBytes) blocks.appendChild(kv('Request size (p50 / p95 / max)', [fmtBytes(e.requestBytes.p50) + ' / ' + fmtBytes(e.requestBytes.p95) + ' / ' + fmtBytes(e.requestBytes.max)]));
    if (e.responseBytes) blocks.appendChild(kv('Response size (p50 / p95 / max)', [fmtBytes(e.responseBytes.p50) + ' / ' + fmtBytes(e.responseBytes.p95) + ' / ' + fmtBytes(e.responseBytes.max)]));
    if (e.cache) blocks.appendChild(kv('Cache', cacheLines(e.cache)));
    if (e.graphql) {
      blocks.appendChild(kv('GraphQL introspection', [e.graphql.introspection ? 'observed' : 'not observed']));
      blocks.appendChild(kv('GraphQL operations', (e.graphql.operations || []).map(function (o) {
        var fields = (o.selections || []).length ? ' → ' + o.selections.join(', ') : '';
        var args = (o.arguments || []).length ? ' (args: ' + o.arguments.join(', ') + ')' : '';
        return (o.name || 'anonymous') + ' (' + o.type + ')' + fields + args;
      })));
    }
    blocks.appendChild(kv('Request headers', headerList(e.requestHeaders)));
    blocks.appendChild(kv('Response headers', headerList(e.responseHeaders)));
    if (e.requestBodySample) blocks.appendChild(codeBlock('Request body', pretty(e.requestBodySample), true));
    if (e.requestBodySchema) blocks.appendChild(codeBlock('Request schema', JSON.stringify(e.requestBodySchema, null, 2), true));
    if (e.requestBodySchemaReason) blocks.appendChild(el('p', 'hint', 'Request schema not fully observed — ' + gapNote(e.requestBodySchemaReason)));
    if (e.responseBodySample) blocks.appendChild(codeBlock('Response body', pretty(e.responseBodySample), true));
    if (e.responseSchema) blocks.appendChild(codeBlock('Response schema', JSON.stringify(e.responseSchema, null, 2), true));
    if (e.responseSchemaReason) blocks.appendChild(el('p', 'hint', 'Response schema not fully observed — ' + gapNote(e.responseSchemaReason)));
    (e.errorResponses || []).forEach(function (error) {
      var label = 'Error ' + error.status;
      blocks.appendChild(kv(label, [error.count + ' occurrence(s)'].concat(error.mimeTypes || [])));
      if (error.bodySample) blocks.appendChild(codeBlock(label + ' body', pretty(error.bodySample), true));
      if (error.schema) blocks.appendChild(codeBlock(label + ' schema', JSON.stringify(error.schema, null, 2), true));
      if (error.schemaReason) blocks.appendChild(el('p', 'hint', label + ' schema not fully observed — ' + gapNote(error.schemaReason)));
    });

    cell.appendChild(blocks);
    row.appendChild(cell);
    return row;
  }

  // ---- rows ----------------------------------------------------------------
  function statusCell(codes) {
    var cell = el('td');
    (codes || []).forEach(function (code, index) {
      if (index) cell.appendChild(document.createTextNode(' '));
      var tone = code >= 500 ? 'status-bad' : (code >= 400 ? 'status-warn' : (code >= 200 && code < 300 ? 'status-ok' : ''));
      cell.appendChild(el('span', tone, code));
    });
    if (!(codes || []).length) cell.textContent = '—';
    return cell;
  }

  function numberCell(value) {
    return el('td', 'num', typeof value === 'number' ? value : '—');
  }

  function rowFor(e) {
    var row = el('tr', 'row' + (e.removed ? ' removed' : '') + (expanded[e.id] ? ' open' : ''));
    row.tabIndex = 0;
    row.setAttribute('data-id', e.id);
    row.setAttribute('aria-expanded', expanded[e.id] ? 'true' : 'false');

    var method = el('td');
    method.appendChild(el('span', 'method m-' + e.method, e.method));
    row.appendChild(method);

    row.appendChild(el('td', 'path', e.urlPattern));
    var categoryCell = el('td');
    categoryCell.textContent = e.removed ? '—' : e.category;
    if (e.vendor) categoryCell.appendChild(el('span', 'vendor', ' · ' + e.vendor.name));
    row.appendChild(categoryCell);
    row.appendChild(statusCell(e.statusCodes));
    row.appendChild(numberCell(e.count));
    var timeCell = el('td', 'num');
    timeCell.textContent = (!e.removed && e.timing) ? e.timing.p95 + ' ms' : '—';
    row.appendChild(timeCell);
    row.appendChild(numberCell(e.removed ? null : (e.triggeredBy || []).length));

    var change = changeById[e.id];
    var changeCell = el('td');
    if (change) {
      var badge = el('span', 'badge ' + (change.breaking ? 'breaking' : change.kind));
      badge.textContent = change.kind + (change.breaking ? ' · breaking' : '');
      changeCell.appendChild(badge);
    } else if (diff) {
      changeCell.textContent = '—';
    }
    row.appendChild(changeCell);

    return row;
  }

  function render() {
    var list = visible();
    rowsEl.textContent = '';
    emptyEl.hidden = list.length > 0;
    countEl.textContent = list.length + ' of ' + allRows.length + ' shown' +
      (removed.length ? ' (' + removed.length + ' only in the baseline)' : '');

    list.forEach(function (e) {
      rowsEl.appendChild(rowFor(e));
      if (expanded[e.id]) rowsEl.appendChild(details(e));
    });
    if (!allRows.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = 'No endpoints were captured.';
    }
  }

  // ---- events --------------------------------------------------------------
  function toggleRow(id) {
    expanded[id] = !expanded[id];
    render();
  }

  rowsEl.addEventListener('click', function (event) {
    var row = event.target.closest ? event.target.closest('tr.row') : null;
    if (row) toggleRow(row.getAttribute('data-id'));
  });

  rowsEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var row = event.target.closest ? event.target.closest('tr.row') : null;
    if (!row) return;
    event.preventDefault();
    toggleRow(row.getAttribute('data-id'));
  });

  qEl.addEventListener('input', function () { state.q = qEl.value; render(); });
  categoryEl.addEventListener('change', function () { state.category = categoryEl.value; render(); });
  methodEl.addEventListener('change', function () { state.method = methodEl.value; render(); });
  statusEl.addEventListener('change', function () { state.status = statusEl.value; render(); });
  breakingEl.addEventListener('change', function () { state.breaking = breakingEl.checked; render(); });
  changedEl.addEventListener('change', function () { state.changed = changedEl.checked; render(); });
  resetEl.addEventListener('click', function () {
    state = { q: '', category: 'all', method: 'all', status: 'all', breaking: false, changed: false, sort: null, dir: 1 };
    qEl.value = '';
    categoryEl.value = 'all';
    methodEl.value = 'all';
    statusEl.value = 'all';
    breakingEl.checked = false;
    changedEl.checked = false;
    expanded = {};
    document.querySelectorAll('thead th.sortable').forEach(function (th) {
      var arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = '';
    });
    render();
  });

  document.querySelectorAll('thead th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) {
        state.dir = -state.dir;
      } else {
        state.sort = key;
        state.dir = 1;
      }
      document.querySelectorAll('thead th.sortable').forEach(function (other) {
        var arrow = other.querySelector('.arrow');
        if (!arrow) return;
        arrow.textContent = other === th ? (state.dir > 0 ? '▲' : '▼') : '';
      });
      render();
    });
  });

  buildControls();
  renderStats();
  renderFindings();
  renderResources();
  render();
})();
`;

/**
 * Escape a string for use inside a `<script type="application/json">` block.
 *
 * `JSON.parse` undoes each of these, so the data is unchanged, but the HTML
 * tokenizer can no longer see a `</script>` — which is what lets a scanned URL
 * or header value contain one without ending the block early.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderDashboard(report: ReconReport, title?: string): string {
  const heading = title ?? `API recon dashboard — ${report.meta.seedUrl}`;
  const hasDiff = report.diff !== undefined;
  const seed = escapeHtml(report.meta.seedUrl);
  // A change between scans can be the engine rather than the API, so call it
  // out next to the engine the current scan used.
  const baselineEngine = report.diff?.baseline.engine;
  const engineMismatch = baselineEngine !== undefined && baselineEngine !== report.meta.engine;

  const columns = [
    { key: 'method', label: 'Method' },
    { key: 'path', label: 'Path' },
    { key: 'category', label: 'Category' },
    { key: 'status', label: 'Status' },
    { key: 'count', label: 'Calls' },
    { key: 'time', label: 'Time (p95)' },
    { key: 'pages', label: 'Pages' },
    ...(hasDiff ? [{ key: 'change', label: 'Change' }] : []),
  ];

  const head = columns
    .map(
      (column) =>
        `<th class="sortable" data-sort="${column.key}" scope="col">${escapeHtml(column.label)}` +
        `<span class="arrow" aria-hidden="true"></span></th>`,
    )
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(heading)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>API recon dashboard</h1>
      <p class="seed">${seed}</p>
    </div>
    <dl class="meta">
      <div><dt>Scanned</dt><dd>${escapeHtml(report.meta.startedAt)}</dd></div>
      <div><dt>api-recon</dt><dd>v${escapeHtml(report.meta.apiReconVersion)}</dd></div>
      <div><dt>Engine</dt><dd>${escapeHtml(report.meta.engine)}${engineMismatch ? ` <span class="badge breaking">baseline: ${escapeHtml(baselineEngine!)}</span>` : ''}</dd></div>
      <div><dt>Robots</dt><dd>${report.safety.robotsRespected ? 'respected' : 'ignored'}</dd></div>
      <div><dt>Redaction</dt><dd>${report.safety.redact ? 'on' : 'off'}</dd></div>
    </dl>
  </header>

  <noscript>
    <div class="panel">
      <p class="hint">This dashboard needs JavaScript. Use <code>report.html</code> or
      <code>report.md</code> for a static view of the same data.</p>
    </div>
  </noscript>

  <section class="stats" id="stats" aria-label="Summary"></section>

  <section class="panel" id="findings" aria-label="Findings"></section>

  <section class="panel" id="resources" aria-label="Resource coverage"></section>

  <div class="panel">
    <div class="controls">
      <input type="search" id="q" placeholder="Search path, method, category, status, host…"
        aria-label="Search endpoints" autocomplete="off" />
      <select id="category" aria-label="Filter by category"></select>
      <select id="method" aria-label="Filter by method"></select>
      <select id="status" aria-label="Filter by status"></select>
      <label class="check"><input type="checkbox" id="changed" /> Changed only</label>
      <label class="check"><input type="checkbox" id="breaking" /> Breaking only</label>
      <button type="button" id="reset">Reset</button>
      <span class="count" id="count"></span>
    </div>
    <table>
      <thead>
        <tr>
        ${head}
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <p class="empty" id="empty" hidden>No endpoints match the current filters.</p>
  </div>
</div>
<script type="application/json" id="report-data">${jsonForScript(report)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export async function writeDashboardReport(report: ReconReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, FORMAT_FILENAMES.dashboard);
  await writeFile(file, renderDashboard(report), 'utf8');
  return file;
}
