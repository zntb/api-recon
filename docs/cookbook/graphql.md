# Scan a GraphQL endpoint

A GraphQL app usually sends everything to one URL — `/graphql`, `/api/graphql`,
`/query` — with the verb, the operation, and the fields hidden in the request
body. A URL-only tool reports one endpoint and stops. `api-recon` recognizes the
operation, so the report is divided the way the API actually is.

## Recognize what makes a request GraphQL

A captured request is treated as GraphQL when it carries any of:

- a JSON body with a `query` document (the usual POST),
- a body sent as `application/graphql`,
- a `query` search parameter (the GET form),
- the `operationName` of an automatic persisted query, with no document.

Nothing is executed or replayed — the document text is only scanned. Such
endpoints are categorized `graphql` and gain a `graphql` object with the
operations seen and whether the schema was introspected:

```jsonc
"graphql": {
  "introspection": true,
  "operations": [
    { "name": "IntrospectionQuery", "type": "query", "selections": ["__schema"] },
    { "name": "GetProducts", "type": "query", "selections": ["products"] }
  ]
}
```

Operation names and their top-level fields are read with a small tokenizer that
ignores keywords inside strings, comments, nested selection sets, fragments, and
directives — so a field named `mutation` is not mistaken for an operation. A
persisted query that names an operation the document does not declare is kept
with the `unknown` type.

## Make the app do the queries

The crawl only sees operations the UI actually fires. Two ways to reach the rest:

```yaml
# flows/graphql.yaml — drive the UI that issues the queries you care about
- wait: 800
- fill: { selector: 'input[type="search"]', value: 'widget' }
- submit: 'form.search'
- click: 'button[aria-label="Next page"]'
- wait: 1000
```

```bash
api-recon https://app.example.com/graphql-app --actions flows/graphql.yaml \
  --depth 1
```

Or record by hand, which is easiest for a query fired from a menu or a detail
view:

```bash
api-recon https://app.example.com --record
```

If the app runs an introspection query on load (many dev and tooling builds do),
you will see it flagged, which is worth knowing before you ship: a production
schema that can still be introspected is a finding in itself.

## The report

- **Markdown / HTML / PDF** list the operations under a GraphQL endpoint, with
  the selections and arguments observed for each.
- **`openapi.yaml`** carries them as `x-graphql-operations` and
  `x-graphql-introspection` extensions, so a consumer that only reads OpenAPI
  still sees what each operation asks for.
- **The dashboard** shows the same, per endpoint.

## Diffing GraphQL

GraphQL endpoints compare operation by operation rather than field by field:

- a **new** operation, or introspection newly appearing, is additive;
- an operation no longer observed is **breaking** — the crawl may simply not
  have exercised it, but a client that calls it would break;
- losing a selection or an argument is **breaking**, the same as a removed REST
  response field; gaining one is additive.

```bash
api-recon baseline https://app.example.com --actions flows/graphql.yaml
# later
api-recon https://app.example.com --actions flows/graphql.yaml \
  --diff latest --fail-on-diff
```

See also: [CI gate](ci-gate.md) for turning that exit code into a failing build,
and the [FAQ](../faq.md) if the endpoint is categorized `mutations` instead —
that means the body did not parse as a GraphQL document.
