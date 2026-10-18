# store-graphql

Auto-generates a **standard GraphQL API** for the common-store data-layer family
(`nodejs-store` / `py-store` / `go-store`) straight from the plain-JSON schema you
already registered.

> **GraphQL is nothing more than another HTTP skin over GQL.** The adapters invent
> zero semantics of their own — every field maps onto store's existing schema / GQL /
> RBAC / relation / computed-column semantics, with **projection pushdown (no N+1)**.

Chinese docs: [README.zh-CN.md](./README.zh-CN.md)

**Going to production?** See [DEPLOYMENT.md](./DEPLOYMENT.md) — context fail-open
countermeasures, built-in guards (body 1MB / limit 50·1000 / depth 10 / fields 300 /
introspection switch), gateway reference config, and the error-prefix alerting table.

## Runtime matrix

| Runtime | Package | Schema build | HTTP transport | Executor | Registry |
|---|---|---|---|---|---|
| Node | `store-graphql-node` | graphql-js programmatic `GraphQLSchema` | `createYoga(store, opts)` → fetch handler; `graphqlPlugin(fastify, opts)` (default `/graphql`, `path` configurable) | graphql-js `execute` (via GraphQL Yoga) | **npm** |
| Python | `store-graphql-py` | graphql-core programmatic `GraphQLSchema` | FastAPI single route (optional; without it you only get the schema) | graphql-core `graphql()` (async) | **PyPI** |
| Go | `store-graphql-go` | graphql-go/graphql programmatic `graphql.Schema` | standard library `net/http` (`Handler(schema, opts)`) | graphql-go `graphql.Do` | in-repo (`go/`) |

**Go v0 differences (called out honestly):**

- `go-store` does **not** read the defn back, so you must pass the same defn list via
  `Options.Schemas` (shared with `gostore.Register`).
- No offline SDL exporter in v0 — SDL is defined by standard **introspection** (the
  endpoint serves it).
- Fragment expansion is not implemented in v0; a request carrying fragments is
  projected field-by-field, and the Go adapter falls back to the full field-key
  projection of the registered defn when fields are missing.
- Inline literals of the `JSON` scalar are rejected (graphql-go's `ParseLiteral` has no
  error channel, so it returns `nil` and the non-null argument check trips) — JSON must
  go through variables.

Everything else (SDL naming, `limit` guard, `__`-prefix filtering, error → HTTP
status mapping, guard thresholds) is **identical across the three runtimes** and lives
in [`spec/`](./spec) plus the shared [`conformance/`](./conformance) cases.

## Table of contents

- [What it is](#what-it-is)
- [When to use it / When not to use it](#when-to-use-it--when-not-to-use-it)
- [Installation](#installation)
- [Quick start](#quick-start)
  - [Node](#node)
  - [Python](#python)
  - [Go](#go)
- [Schema generation](#schema-generation)
- [Execution mapping](#execution-mapping)
- [Customization hooks](#customization-hooks)
- [Errors & context](#errors--context)
- [Scenario walkthroughs](#scenario-walkthroughs)
- [Production deployment](#production-deployment)
- [v0 scope and non-goals](#v0-scope-and-non-goals)
- [FAQ](#faq)
- [Development](#development)
- [Related projects](#related-projects)
- [License](#license)

## What it is

A thin, per-runtime adapter that reflects store's registered JSON schema into a
standard GraphQL schema and executes requests through store's existing GQL path.

1. **Single generation source** — the store's plain JSON schema (`defn`), the *same*
   source used by the REST skin `store-api`. The adapter introduces no second type
   system.
2. **Surface** — for every model `X`, it generates `get_X` / `list_X` on `Query` and
   `create_X` / `update_X` / `delete_X` on `Mutation`. Field types are reflected from
   the defn (nested `object`s are walked down into nested object types; dynamic
   structures become the `JSON` scalar).
3. **Projection pushdown** — the GraphQL selection is serialized back into the
   existing GQL projection string, so **one `store.query` fetches the whole tree**.
   Relation subqueries, aggregation, computed columns, RBAC and dialect routing are
   all inherited from core. Sub-field resolvers only do static lookups.
4. **SDL exit** — `exportSDL(schema)` / `export_sdl(schema)` (Node / Python) and
   introspection (all runtimes) feed `@graphql-codegen` / `ariadne-codegen` /
   genqlient.
5. **`__`-prefix built-in models filtered** — core's control-plane built-in models are
   named with a `__` prefix (`__schemaDef` / `__workflowRun` / `__workflowDef` /
   `__feedback`). `__` is reserved by the GraphQL spec (introspection), so they are
   **unconditionally** filtered out of the schema and never exposed for query. This
   filter is GraphQL-skin-only (REST / gRPC / MCP have no such rule) and therefore is
   *not* merged into the `filterArchived` rule that is kept byte-for-byte identical
   with `store-api`; it applies even when you pass an explicit `resources` list.

### The store port contracts it depends on

The adapters only use these public store methods (duck-typed; Go aligns with the
`gostore.Store` interface — no import of a concrete store type for runtime binding):

| Capability | nodejs-store | py-store | go-store |
|---|---|---|---|
| List model names | `store.list()` → `string[]` | `store.list()` → `list[str]` | pass explicitly via `Options.Schemas` |
| Get a model defn | `store.get(name)` | `store.get(name)` | the same defn you passed in |
| GQL query | `store.query(gql, params)` | `store.query(gql, params)` | `Query(ctx, gql, params, actx)` |
| Writes | `store.insert/update/remove(...)` | `store.insert/update/remove(...)` | `Insert/Update/Remove(ctx, ...)` |
| Context | `store.setContext(ctx)` | `store.set_context(ctx)` | explicit `actx` argument |

## When to use it / When not to use it

**Use it when**

- You already have a store JSON schema and want a browsable, typed, self-documenting
  API without hand-writing SDL or resolvers.
- A frontend team wants GraphiQL for exploration and codegen'd typed clients.
- You need to fetch a whole nested tree in one round-trip and care about avoiding
  N+1 (mobile clients, BFF aggregation).
- You want a declarative way to narrow the API surface (hide internal tables,
  read-only audit tables) without touching code.

**Do not use it when**

- You need real-time push semantics (subscriptions) — store has none, and this skin
  does not invent them.
- You need offset/paging-by-skip, output aliases, or an aggregate `count_X` root — all
  deferred to v1 (see [v0 scope](#v0-scope-and-non-goals)).
- You need write-heavy GraphQL batching — batching is off (one document per request).
- You want the adapter to own authn — it does not; you inject a context provider and
  store's RBAC does the rest.

## Installation

**Node (npm)**

```bash
npm i store-graphql-node          # pulls in graphql + graphql-yoga (optional dep)
npm i fastify                     # only if you use the Fastify plugin graphqlPlugin
npm i nodejs-store                # the host data layer (peer, optional)
```

**Python (PyPI)**

```bash
pip install store-graphql-py              # graphql-core only; you own the transport
pip install "store-graphql-py[fastapi]"   # adds FastAPI for create_app()
pip install py-store                      # the host data layer
```

**Go (in-repo module)**

```bash
go get github.com/coenddt/store-graphql-go
```

## Quick start

### Node

A runnable end-to-end example (mirrors `node/test/e2e.real.test.js` — real
`nodejs-store` + `better-sqlite3`):

```js
// quickstart.js — run with: node quickstart.js
const { createServer } = require('node:http');
const Database = require('better-sqlite3');
const { init, store, executors } = require('nodejs-store');
const { createYoga, exportSDL } = require('store-graphql-node');

const DEFN = {
  name: 'User',
  collection: 'users',
  idPrefix: 'u',
  description: '用户表：平台账号主档',
  fields: {
    _id: { type: 'string', description: '主键，u 前缀' },
    name: { type: 'string' },
    age: { type: 'int' },
    profile: { type: 'object', description: '个人资料', fields: { bio: { type: 'string' } } },
  },
};

async function main() {
  const db = new Database(':memory:');
  // SQL source must be a { kind, exec } descriptor, never a bare driver instance.
  await init({ default: executors.createConnection('sqlite', db) });
  store.register(DEFN);
  // nodejs-store never writes DDL; it prints it and you run it.
  db.exec(store.generateDdl('sqlite', ['User']));
  db.exec(store.generateDdl('sqlite', ['UserDeleted'])); // archive table, auto-registered by core

  const { yoga, schema } = createYoga(store);   // GraphiQL included; schema held separately
  createServer(yoga).listen(4000);              // http://localhost:4000/graphql

  console.log(exportSDL(schema));               // SDL string → write to disk for codegen
}

main();
```

Prefer Fastify? Register the plugin instead of standing up a raw server:

```js
const fastify = require('fastify')({ logger: true });
await fastify.register(require('store-graphql-node').graphqlPlugin, {
  store,
  path: '/graphql',                 // default '/graphql'
  contextFactory: async ({ request }) => ({ userId: request.headers['x-user'] }),
});
await fastify.listen({ port: 4000 });
```

### Python

```python
# quickstart.py — pip install py-store aiosqlite "store-graphql-py[fastapi]"
import asyncio
import aiosqlite
import py_store
from store_graphql import build_graphql_schema, create_app, export_sdl

DEFN = {
    "name": "User",
    "collection": "users",
    "idPrefix": "u",
    "description": "用户表：平台账号主档",
    "fields": {
        "_id": {"type": "string", "description": "主键，u 前缀"},
        "name": {"type": "string"},
        "age": {"type": "int"},
        "profile": {"type": "object", "description": "个人资料", "fields": {"bio": {"type": "string"}}},
    },
}

async def main():
    async with aiosqlite.connect(":memory:") as db:
        await py_store.init({"default": py_store.executors.create_connection("sqlite", db)})
        py_store.store.register(DEFN)
        # py-store never writes DDL either; aiosqlite's executescript is a coroutine.
        await db.executescript(py_store.store.generate_ddl("sqlite", ["User"]))
        await db.executescript(py_store.store.generate_ddl("sqlite", ["UserDeleted"]))

        schema = build_graphql_schema(py_store.store)
        app = create_app(py_store.store, schema=schema)   # FastAPI app; GET /graphql → GraphiQL
        print(export_sdl(schema))                         # SDL string for ariadne-codegen

        # Or skip FastAPI entirely and execute yourself:
        # from graphql import graphql
        # result = await graphql(schema, "{ list_User { _id name } }")

asyncio.run(main())
```

Serve the FastAPI app with `uvicorn quickstart:app` (or `create_app` it inline and run
uvicorn programmatically).

### Go

```go
// see go/demo/main.go for a complete program — run with: go run ./demo
st, _ := gostore.Open("sqlite::memory:")
defer st.Close()
_ = st.Register(userDefn)

schema, err := storegraphql.Build(st, storegraphql.Options{
    Schemas: []map[string]any{userDefn}, // go-store does not read the defn back; share the same one as Register
    ContextProvider: func(r *http.Request) (*gostore.Context, error) {
        return nil, nil // returning nil still injects explicitly (clears identity)
    },
})
if err != nil {
    log.Fatal(err)
}

mux := http.NewServeMux()
mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
log.Fatal(http.ListenAndServe(":4000", mux))
```

## Schema generation

Source of truth: [`spec/01-schema-generation.md`](./spec/01-schema-generation.md).

**Generation source.** Node / Python reflect `store.list()` at startup (after archive
filtering) and call `store.get(name)` per model. Go uses the defn list you pass in
`Options.Schemas` — `gostore.Register(defn)` does not read it back, so the adapter and
the registration share the same copy.

**Resource filtering (identical to `store-api`).** A name ending in `Deleted` whose
base name is *also* in the list is an archive table and generates no types or fields
(`User` + `UserDeleted` → only `User`). An explicit `resources` list is filtered by
the same rule.

**Type mapping** (`defn.fields.*.type` → GraphQL output type):

| defn `type` | GraphQL type | Note |
|---|---|---|
| `string` / `datetime` | `String` | datetime is passed through as an ISO string in v0; no custom scalar |
| `int` | `Int` | |
| `float` | `Float` | |
| `bool` | `Boolean` | |
| `object` (with `fields`) | nested `ObjectType` named `<ParentType>_<fieldPath>` | recursed downward |
| `object` (without `fields`) / `array` / anything unknown | `JSON` (custom scalar) | the smallest honest promise — never drop semantics |

- `_id` → `ID!` (non-null). **Every other field is nullable** — a missing default or a
  permission trim can both produce `null`, so the adapter makes no unfounded
  non-null promise.
- `computes.*` are treated as fields and enter the type (same mapping; in the
  course-platform defn each `compute` carries its own `type`).

**Generated surface.**

```graphql
type X { _id: ID!, ...fields, ...computes }

type Query {
  get_X(id: ID!): X
  list_X(condition: JSON, sort: JSON, limit: Int): [X!]!
}

type Mutation {
  create_X(input: JSON!): X
  update_X(id: ID!, set: JSON!): X
  delete_X(id: ID!): Boolean!
}
```

For the `User` defn above, `exportSDL(schema)` prints (abridged):

```graphql
"""用户表：平台账号主档"""
type User {
  """主键，u 前缀"""
  _id: ID!
  name: String
  age: Int
  """个人资料"""
  profile: User_profile
}

type User_profile {
  bio: String
}

type Query {
  get_User(id: ID!): User
  list_User(condition: JSON, sort: JSON, limit: Int): [User!]!
}

type Mutation {
  create_User(input: JSON!): User
  update_User(id: ID!, set: JSON!): User
  delete_User(id: ID!): Boolean!
}
```

**The `JSON` custom scalar.** It carries any JSON value — used for `condition`, `sort`,
`input` and `set`. It **only accepts variables**; inline literals are rejected on all
three runtimes (Node's graphql-js and Python's graphql-core throw in `parseLiteral`;
Go's `ParseLiteral` returns `nil` and the non-null check trips).

**`description` pipeline.** `defn.description` and `fieldDefn.description` (JSON-Schema
convention) are copied verbatim into SDL triple-quoted comments at the model, field,
computed-column and nested-object level — the adapter transports, it never rewrites.
See [`spec/05-documentation.md`](./spec/05-documentation.md).

**SDL export.** Node: `exportSDL(schema)` (`printSchema`). Python: `export_sdl(schema)`
(`print_schema`). Go: v0 has no offline exporter; SDL is defined by introspection.

> **To be verified (v1):** the real core parameter name for offset paging
> (`$skip` / `$page`) — until confirmed, `list_X` exposes no offset argument (better
> to omit than invent). The `count_X` aggregation root (`QueryWithCount`, already in
> Go) needs a Node/Python equivalent — until confirmed it is not generated.

## Execution mapping

Source of truth: [`spec/02-execution-mapping.md`](./spec/02-execution-mapping.md).

Core strategy: **projection pushdown**. The root resolver serializes the GraphQL
selection back into an existing GQL projection string and issues a single
`store.query` — no N+1, and relations / aggregation / computed columns / permissions /
dialect all ride the original core path.

**Query → GQL string.**

| GraphQL argument | GQL fragment | params key | When appended |
|---|---|---|---|
| `condition` | `$condition:@c0` | `c0` | only when non-null |
| `sort` | `$sort:@s1` | `s1` | only when non-null |
| `limit` | `$limit:@l` | `l` | always (see the limit guard) |

- `get_X(id)` ⇒ `X($condition:@c0) { <projection> }` with `c0 = {"_id": id}`; returns
  the first row, or `null` if empty.
- `list_X(...)` ⇒ the parameter head above (as needed) plus `{ <projection> }`.
- The primary-key field name `id_field` is fixed to `_id` in v0 (same as `store-api
  spec/01`; the argument surface does not change).

**The limit guard (adapter-level semantics).** Core's row cap (`clamp_t2q_limit` /
`force_t2q_limit`) only applies to the `text2query` profile; the default `standard`
profile returns rows as-is. The GraphQL endpoint uses the default profile, so without a
guard `limit` would fetch everything. The resolvers therefore:

- **default to `limit: 50`** (always emit `$limit:@l`), and
- **throw when an explicit `limit > 1000`**, with the stable message prefix
  **`ERR_LIMIT:`** so clients can detect it. This follows "allowed to be intercepted,
  never silently fail" — no silent truncation.

`limit ≤ 0` and non-integers are passed straight to core; their meaning belongs to
core (the adapter does not invent it). The numbers (default 50, cap 1000) are
adapter-level constants — change the spec first, then all three runtimes.

**Mutation semantics.**

| Operation | store call | Returns |
|---|---|---|
| `create_X` | `insert(X, input)` | the full document after insert |
| `update_X` | `update(X, {"_id": id}, set)`, then read back by selection | the read-back document (does not rely on `update`'s return shape; identical on all runtimes) |
| `delete_X` | `remove(X, {"_id": id})` | `true` (failures go through the error channel) |

**Selection → projection string** (Node / Python do exact pushdown):

1. `FIELD` ⇒ `name` plus a nested `{ }` if present. **Output aliases are ignored in
   v0** (output by field name; core's GQL projection has no alias semantics).
2. `InlineFragment` ⇒ expand its selection set in place.
3. `FragmentSpread` ⇒ look up `info.fragments`, then recurse.
4. `@skip` / `@include` ⇒ evaluated during serialization (`if` read from
   `info.variableValues`; custom serialization bypasses the executor's directive
   filtering, so it must evaluate them itself).
5. Empty-projection defense ⇒ if the serialized result is empty, fall back to `_id`
   so the GQL string stays valid.

**Paging.** No offset/skip paging and no cursor (`$skip` / `$page` are "to be
verified" in v1). `list_X` is capped by `limit` (default 50, hard cap 1000).

**Go v0 differences.** Projection serialization reads `ResolveParams.Info.FieldASTs`
directly; fragment expansion is not implemented (v1), so a request with fragments is
projected field-by-field and, when fields are missing, Go falls back to the full
field-key projection of the registered defn.

## Customization hooks

Auto-generation is not a cage. Four hooks, ordered by increasing intrusiveness; all are
official adapter APIs. Source of truth:
[`spec/03-customization.md`](./spec/03-customization.md).

### Hook 1 — Annotations (declarative, no code change)

Put an `x-graphql` key on the defn:

```json
{ "name": "SecretLog",  "x-graphql": { "hidden":   true }, "fields": { "...": {} } }
{ "name": "AuditEvent", "x-graphql": { "readonly": true }, "fields": { "...": {} } }
```

- `hidden` — the whole model stays out of SDL (internal / sensitive tables).
- `readonly` — only the Query surface is emitted (audit / log tables; store RBAC still
  applies independently — the annotation just narrows the GraphQL surface).
- Field-level annotations are not in v0 (the input is a `JSON` scalar, so there is
  nowhere on SDL to express them; write trimming belongs to store RBAC —
  `fields.role.read: ["admin"]` is already enforced in core).

### Hook 2 — Override (swap behavior, keep SDL)

Replace a generated resolver by field path; the generated surface stays unchanged:

```js
// Node
buildGraphQLSchema(store, {
  overrides: {
    'Query.list_User': async (src, args, ctx, info) => myCustomList(args, info),
  },
});
```

```python
# Python
build_graphql_schema(store, overrides={"Query.list_User": my_custom_list})
```

```go
// Go
storegraphql.Build(st, storegraphql.Options{
    Overrides: map[string]graphql.FieldResolveFn{
        "Query.list_User": func(p graphql.ResolveParams) (interface{}, error) { return myCustomList(p) },
    },
})
```

Paths are `Query.<field>` / `Mutation.<field>` and correspond one-to-one with the
generated surface; unmatched paths use the default resolver. **Unknown paths are a
build-time error** — never silently ignored.

### Hook 3 — Extend (add fields, SDL follows)

Append custom fields to `Query` / `Mutation` (any type, may use the `JSON` scalar):

```js
// Node: a cross-model business field; internally still store semantics
buildGraphQLSchema(store, {
  extensions: {
    Query: {
      courseStats: {
        type: GraphQLJSON,
        resolve: async () => store.query('Course { groupBy($by:@b) { ... } }', { b: { /* ... */ } }),
      },
    },
  },
});
```

Python: `extensions={"Query": {...}}`. Go: `Extensions map[string]graphql.Fields` (keys
`Query` / `Mutation`). Extended fields sit **at the same level** as generated fields in
SDL and introspection, so client tooling treats them identically. An extension key
other than `Query` / `Mutation` is a build-time error.

### Hook 4 — Escape hatch (schema-first takeover)

Dump SDL with `exportSDL(schema)` → edit it by hand → reload in schema-first mode. The
generator output is a starting point, not a cage:

- Node: `makeExecutableSchema` (graphql-tools) or feed the SDL to any executor.
- Python: Ariadne (the SDL-first framework).
- Go: gqlgen (generate Go from SDL, leaving the runtime-reflection route).

After you take the escape hatch, the override/extend hooks no longer apply (the types
have left this adapter's lifecycle), but store calls still go through the same
`store.query` — semantics are not bypassed.

**Constraint (to protect parity).** Custom resolvers may call any public store
semantics (query/insert/update/remove/native commands) but must not bypass the RBAC
context injection.

## Errors & context

Source of truth: [`spec/04-errors-context.md`](./spec/04-errors-context.md).

**Error channel.** A store error enters the standard GraphQL `errors` array with the
message **passed through verbatim** — never swallowed, rewritten, or cross-semantic
fallback. `data` and `errors` coexist per GraphQL's native semantics (partial list
failure nulls the field and records an error). A success response must contain no error
text, and a resolver's return value *is* the data — no success/failure wrapper.

**Context (identical pattern to `store-api spec/04`).** A `ContextProvider` hook maps
an HTTP request to a store user context:

| Runtime | Hook | Injection |
|---|---|---|
| Node | `opts.contextFactory({ request, serverContext })` | `store.setContext(ctx)` |
| Python | `context_provider(request)` (async supported) | `store.set_context(ctx)` |
| Go | `opts.ContextProvider(req)` | `context.WithValue` carrying `*gostore.Context` |

- A provider returning `nil` / `None` is **still injected explicitly** — the clear
  semantics must land, so identity never leaks across requests.
- A provider that throws a permission-class error ⇒ **403**; anything else ⇒ **401**
  (message passed through).

**Error → HTTP status matrix** (programmatically distinguishable; verified by
`node/test/error-matrix.test.js` and `py/tests/test_error_matrix.py`):

| Error class | Detection | HTTP | `extensions.code` |
|---|---|---|---|
| RBAC denial | core stable prefix `ERR_PERMISSION:` | **403** | `FORBIDDEN` |
| Missing context | machine code `no_context` / `NoContextError` / prefix `ERR_NO_CONTEXT:` | **403** | `FORBIDDEN` |
| Any other context error | everything else | **401** | — |
| Any other resolver error | message passed through verbatim | **200** + `errors` | — |

Permission-class errors are matched by **type / machine code / stable prefix, never by
message text**. On Node the default Yoga mask preserves the message and adds the 403 +
`FORBIDDEN` extension; Python / Go emit `FORBIDDEN`-equivalent status at the HTTP layer.

**GraphQL over HTTP.**

- `POST application/json` with `{ query, variables, operationName }` ⇒
  `application/json` response.
- `GET /graphql` returns the GraphiQL documentation page. GET query execution
  (`?query=&variables=`) is deferred to v1.
- Introspection is the executor's native capability and is **on by default** (SDL /
  GraphiQL / codegen depend on it); it is switchable off in production.

**Request body cap.** 1MB on all three runtimes (matching the `store-api` precedent
`io.LimitReader(r.Body, 1<<20)`). Go truncates and fails to decode ⇒ 400; Python ⇒ 413;
Node sets Yoga's `maxRequestBodySize: 1MB` (Yoga's default is 25MB) ⇒ 413.

**Security model v0.** All user input (`id` / `condition` / `sort` / `limit` / `input` /
`set`) travels through the params value channel — zero string concatenation into GQL.
Patterns are enforced in core's IR layer. Context isolation uses py ContextVar / node
AsyncLocalStorage / go explicit `actx`. Per-request depth, field-count and introspection
guards are described in [Production deployment](#production-deployment).

## Scenario walkthroughs

Each scenario uses the `User` defn
(`{ _id, name, age, profile { bio } }`) so every type and field name in the queries
below comes straight from the repository's source and
[`conformance/cases/users-graphql.json`](./conformance/cases/users-graphql.json).

### 1. Fetch a nested tree in one round-trip (no N+1)

**Business background.** A profile screen needs a user and its nested profile in one
shot; a naive resolver-per-field design would issue a second query per row.

**Request.**

```graphql
query($c: JSON, $l: Int) {
  list_User(condition: $c, limit: $l) {
    _id
    name
    profile { bio }
  }
}
```

Variables: `{ "c": { "name": "a" }, "l": 10 }`

**What the adapter does internally** — the selection is pushed down into a single GQL
projection (exact string from `node/test/smoke.test.js`):

```
User($condition:@c0,$limit:@l) { name, profile { bio } }
params = { c0: { name: "a" }, l: 10 }
```

**Response.**

```json
{
  "data": {
    "list_User": [
      { "_id": "u1", "name": "a", "profile": { "bio": "hello" } }
    ]
  }
}
```

**Why it wins.** One `store.query` fetches the whole tree; each nesting level of the
defn becomes a nested GraphQL object type (`profile` → `User_profile`) resolved from the
same row — no per-row follow-up query, no N+1.

### 2. Frontend GraphiQL self-service + introspection

**Business background.** A frontend engineer wants to explore the API and check field
descriptions without reading backend code.

**Request.** Open `GET /graphql` in a browser — Node serves Yoga's built-in landing
page; Python and Go return the bundled GraphiQL HTML page (queries execute via `POST`).
Then run the liveness check:

```graphql
{ __typename }
```

**Response.**

```json
{ "data": { "__typename": "Query" } }
```

**Why it wins.** The schema browser reads introspection (including every
`description`), gives autocomplete, and needs zero extra setup from the adapter.

### 3. Generate a typed TypeScript client with `@graphql-codegen`

**Business background.** The frontend wants compile-time types instead of hand-written
HTTP calls.

**Step 1 — export SDL (Node).**

```js
const { exportSDL } = require('store-graphql-node');
require('node:fs').writeFileSync('schema.graphql', exportSDL(schema));
```

**Step 2 — configure codegen.**

```yaml
# codegen.yml
schema: ./schema.graphql
documents: ./src/**/*.graphql
generates:
  ./src/gql/:
    preset: client
```

**Step 3 — author a document and call it.**

```graphql
# src/queries/ListUsers.graphql
query ListUsers($c: JSON, $l: Int) {
  list_User(condition: $c, limit: $l) { _id name }
}
```

```ts
import { GraphQLClient } from 'graphql-request';
import { getSdk } from './gql/graphql';

const sdk = getSdk(new GraphQLClient('http://localhost:4000/graphql'));
const { list_User } = await sdk.ListUsers({ c: { name: 'a' }, l: 10 });
```

**Why it wins.** SDL is the single exit point; the adapter ships no client generator of
its own, so any standard toolchain (`ariadne-codegen` for Python, `genqlient` for Go)
works unchanged.

### 4. BFF read-only aggregation

**Business background.** A backend-for-frontend wants to expose one filtered, sorted,
bounded read to a mobile app without building a bespoke endpoint.

**Request.**

```graphql
query($c: JSON, $s: JSON, $l: Int) {
  list_User(condition: $c, sort: $s, limit: $l) {
    _id
    name
    age
  }
}
```

Variables: `{ "c": { "age": 18 }, "s": { "age": -1 }, "l": 20 }`

**What the adapter does internally:**

```
User($condition:@c0,$sort:@s1,$limit:@l) { _id, name, age }
params = { c0: { age: 18 }, s1: { age: -1 }, l: 20 }
```

**Response.**

```json
{
  "data": {
    "list_User": [
      { "_id": "u1", "name": "a", "age": 30 }
    ]
  }
}
```

**Why it wins.** `condition` / `sort` / `limit` map onto the GQL string verbatim, so
RBAC row filtering, computed columns and dialect routing all still apply — the BFF
gains no new semantics and no data is cached in the adapter.

### 5. Admin CRUD

**Business background.** An admin console creates, edits, and deletes records.

**Create.**

```graphql
mutation($input: JSON!) {
  create_User(input: $input) { _id name age }
}
```

Variables: `{ "input": { "name": "alice", "age": 30 } }` → returns the inserted document
with a real generated `_id` (e.g. `"u1"`, `u`-prefixed by `idPrefix`).

**Update (writes then reads back by selection).**

```graphql
mutation($id: ID!, $set: JSON!) {
  update_User(id: $id, set: $set) { name age }
}
```

Variables: `{ "id": "u1", "set": { "age": 31 } }` → `{ "update_User": { "name": "alice", "age": 31 } }`

**Delete.**

```graphql
mutation { delete_User(id: "u1") }
```

→ `{ "delete_User": true }`; a subsequent `{ list_User { _id } }` returns `[]`.

**Why it wins.** Writes reuse store's `insert/update/remove`, so archive orchestration
and RBAC apply; `update` deliberately reads back so all runtimes agree regardless of
`update`'s raw return shape.

### 6. Hide an internal model (`x-graphql.hidden`)

**Business background.** An internal `SecretLog` table must not be reachable over
GraphQL at all.

**Setup.**

```json
{ "name": "SecretLog", "x-graphql": { "hidden": true }, "fields": { "_id": { "type": "string" } } }
```

**Verification.** `exportSDL(schema)` contains no `SecretLog`, and
`schema.getType('SecretLog')` is `undefined`.

**Why it wins.** It is one declarative key on the defn — no code change, no per-request
check — and it is enforced at build time so the model is invisible to introspection and
GraphiQL too.

### 7. Read-only model (`x-graphql.readonly`)

**Business background.** An audit table may be read but never written through GraphQL.

**Setup.**

```json
{ "name": "AuditEvent", "x-graphql": { "readonly": true }, "fields": { "_id": { "type": "string" } } }
```

**Verification.** SDL contains `get_AuditEvent` (and `list_AuditEvent`) but **no**
`create_AuditEvent` / `update_AuditEvent` / `delete_AuditEvent`.

**Why it wins.** The GraphQL surface is narrowed declaratively while store RBAC keeps
enforcing independently — two independent layers, no duplicated logic.

### 8. Override one resolver by path

**Business background.** `list_User` must return a specialized shape computed outside
the generic path, but the schema must not change.

**Setup (Node).**

```js
buildGraphQLSchema(store, {
  overrides: {
    'Query.list_User': async () => [{ _id: 'x', name: 'override', age: 0, profile: null }],
  },
});
```

**Request / response.**

```graphql
{ list_User { name } }
```

→ `{ "data": { "list_User": [ { "name": "override" } ] } }`

An unmatched path such as `Query.list_Nope` makes the build throw
`override 路径 "..." 未命中任何生成字段` instead of silently doing nothing.

**Why it wins.** You swap behavior at exactly one path while SDL stays byte-identical,
so clients and codegen are unaffected.

### 9. Production guards in action

**Business background.** An endpoint faces the internet; you need hard ceilings so a
single request cannot exhaust memory or open a denial-of-service hole.

**Request body over 1MB** → `413`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4000/graphql \
  -H 'content-type: application/json' --data-binary @huge.json   # 413
```

**Over-limit `limit`** → HTTP 200 with `errors[0].message` starting `ERR_LIMIT:`:

```graphql
query($l: Int) { list_User(limit: $l) { _id } }   # variables: { "l": 1001 }
```

**Too-deep query** (depth 11 > 10) → **HTTP 400**, `errors[0].message` starting
`ERR_DEPTH:`; **too many fields** (> 300) → 400 `ERR_COMPLEXITY:`; a `__schema` request
with introspection disabled → 400 `ERR_INTROSPECTION:` (a bare `__typename` is still
allowed).

**Why it wins.** Every ceiling ships with the adapter and fails loudly with a stable
prefix — nothing is silently truncated.

### 10. Permission error → 403 (not 401)

**Business background.** A request fails RBAC; the client must distinguish "denied" from
"authentication broken".

**Setup (Node).**

```js
createYoga(store, {
  contextFactory: async ({ request }) => {
    const token = request.headers.get('authorization');
    const user = token ? await verifyToken(token) : null;
    if (!user) throw new Error('ERR_PERMISSION:无访问权限');
    return { userId: user.id, roles: user.roles };
  },
});
```

**Response.**

```json
{
  "errors": [
    { "message": "ERR_PERMISSION:无访问权限", "extensions": { "code": "FORBIDDEN" } }
  ]
}
```

with HTTP status **403**. A generic provider failure (e.g. `上下文钩子故障`) yields **401**
instead.

**Why it wins.** Classification is by stable prefix / machine code / type — never by
message text — so a translated or reworded message cannot change the status code.

## Production deployment

Full checklist: [DEPLOYMENT.md](./DEPLOYMENT.md). The adapter guarantees *semantic*
safety (injection surface, context isolation, guards); *deployment* safety is the
checklist's job.

**1. Context (highest priority).** Core's trust model is **fail-open**: `ctx: None`
means "skip permission checks" (`core/src/permission.rs:9-20`). With no context
provider the endpoint is anonymous read/write over the whole store. Two must-dos:

| Item | Node | Python | Go |
|---|---|---|---|
| Per-request hook | `createYoga(store, { contextFactory })` (returning `null` still clears identity) | `create_app(store, context_provider=...)` (async ok) | `Handler(schema, Options{ ContextProvider: ... })` |
| fail-secure switch | `store.setRequireContext(true)` | `store.set_require_context(True)` | rust host `store.set_require_context(true)` (go-store via FFI) |

With fail-secure on, a missing context errors explicitly at the plan entry point.
Node / Python also refuse to assemble at startup (`ERR_SECURE_CONFIG`) if fail-secure is
on but no context hook was configured — fail fast, never silently degrade.

**2. Built-in guards (no deployment config required).**

| Guard | Default | On violation | Override |
|---|---|---|---|
| Request body | 1MB | 413 / 400 | Node `maxRequestBodySize` (Yoga); Go `maxBodyBytes`; Python constant |
| list limit | default 50 / cap 1000 | throw `ERR_LIMIT:` | spec/02 constants |
| Query depth | 10 | 400 `ERR_DEPTH:` | `maxQueryDepth` / `max_query_depth` / `MaxQueryDepth` (0 = default) |
| Query complexity | 300 fields | 400 `ERR_COMPLEXITY:` | `maxQueryFields` / `max_query_fields` / `MaxQueryFields` (0 = default) |
| Introspection | on | when off, 400 `ERR_INTROSPECTION:` | `introspection: false` / `DisableIntrospection: true` |

For public exposure prefer `introspection: false` (export SDL for codegen inside the
private network first).

**3. Gateway (nginx reference).** The adapter does no connection-level protection; put
it behind a reverse proxy:

```nginx
server {
  location /graphql {
    limit_req zone=graphql burst=20 nodelay;   # per-IP 10 r/s, burst 20
    proxy_read_timeout 10s;                    # cut slow queries
    proxy_pass http://127.0.0.1:4000;
  }
}
# in the http block: limit_req_zone $binary_remote_addr zone=graphql:10m rate=10r/s;
# TLS terminates at the gateway (the adapter serves plain HTTP); CORS is a gateway concern.
```

**4. Error-prefix alerting table.** A guard firing is an upstream anomaly signal; wire
it into alerting:

| Prefix | Meaning | Alert action |
|---|---|---|
| `ERR_PERMISSION:` | RBAC denial (core) | high frequency = privilege probing; aggregate source IP |
| `ERR_LIMIT:` | `limit` over cap | high frequency = broken client paging |
| `ERR_DEPTH:` | depth over cap | any occurrence = attack attempt; alert |
| `ERR_COMPLEXITY:` | field count over cap | any occurrence = attack attempt; alert |
| `ERR_INTROSPECTION:` | schema probing while disabled | any occurrence = reconnaissance; alert |
| 401 `CONTEXT_ERROR` | context hook failure | **alert immediately** (the auth chain is broken, not a user error) |

## v0 scope and non-goals

**Supported**

- Query: `get_X` / `list_X` with `condition` / `sort` / `limit`
  (**limit defaults to 50, caps at 1000, over-limit throws `ERR_LIMIT:`** — core's row
  cap only applies to the text2query profile; the adapter enforces the upper bound, see
  `spec/02`).
- Mutation: `create_X` / `update_X` / `delete_X`.
- Introspection; fragments and `@skip` / `@include` (implemented on Node / Python / Go).
- Annotations (`x-graphql.hidden` / `x-graphql.readonly`), overrides, extensions, and
  the schema-first escape hatch.

**Not supported (explicit non-goals)**

- **subscriptions** — store has no subscription semantics, so the skin does not invent
  them.
- Output aliases, skip/offset paging (`$skip`), and the `count_X` aggregation root —
  deferred to v1 after the core semantics are confirmed (see the "to be verified" notes
  in `spec/01` and `spec/02`).
- Request batching — one document per request on all runtimes.
- Field-level annotations in v0 — write trimming stays with store RBAC.

**Go v0 differences.** No offline SDL export (introspection is the SDL source); fragment
expansion not implemented (v1); inline `JSON` literals rejected with a non-null
validation error (`graphql-go`'s `ParseLiteral` has no error channel).

## FAQ

**1. Do I have to write SDL by hand?**
No. SDL is generated from your registered JSON schema. Hand-writing SDL is only the
Hook 4 escape hatch if you want to take over completely.

**2. Why does the `JSON` scalar reject inline literals?**
`condition` / `sort` / `input` / `set` can be arbitrarily nested JSON, which is awkward
to express as literal GraphQL syntax. The scalar therefore accepts values only through
**variables** (the Hasura-style pragmatic choice). Inline literals are rejected on all
runtimes.

**3. Why does `limit` default to 50 and cap at 1000?**
Core's row cap only applies to the `text2query` profile, so on the default profile an
omitted `limit` would fetch the whole table. The adapter adds the ceiling; over-limit
throws `ERR_LIMIT:` rather than truncating silently.

**4. Why are my `__`-prefixed models missing?**
`__` is reserved by the GraphQL spec for introspection. Core's control-plane models
(`__schemaDef`, `__workflowRun`, …) would make the whole schema invalid, so they are
unconditionally filtered out.

**5. Can I change the naming (`get_User`, `list_User`, …)?**
The naming is fixed and part of the cross-runtime contract. To reshape it, use Hook 4
(edit SDL) or Hook 3 (add fields with your own names).

**6. Does it support subscriptions?**
No — store has no subscription semantics and the skin invents none.

**7. Does it support offset paging, aliases, or `count_X`?**
Not in v0. The core parameter names for offset paging and a Node/Python
`QueryWithCount` equivalent are still "to be verified", so these are deferred to v1
rather than guessed.

**8. How do I customize a single resolver without changing the schema?**
Use Hook 2 — override by path, e.g. `overrides: { 'Query.list_User': myResolver }`.

**9. How do I disable introspection in production?**
Pass `introspection: false` (Node/Python) or `DisableIntrospection: true` (Go). Requests
containing `__schema` / `__type` then get 400 `ERR_INTROSPECTION:`; `__typename` is
still allowed.

**10. Why do I sometimes get 403 and sometimes 401?**
Role-based denial (prefix `ERR_PERMISSION:`, or the permission-class `NoContext`) is
**403**; any other context-hook failure is **401**. The classification is by
type/machine-code/prefix, never by message text.

**11. What exactly differs on the Go runtime?**
Schema generation needs `Options.Schemas` (go-store does not read the defn back); there
is no offline SDL exporter (introspection is the source); fragments are not expanded in
v0; and inline `JSON` literals are rejected. Everything else matches Node/Python.

**12. Does GraphQL re-implement RBAC, computed columns, or relations?**
No. All of that is inherited from core through the pushed-down GQL projection; the skin
only reflects the schema and serializes the selection.

## Development

```bash
# Node — node:test (smoke, error-matrix, conformance, e2e.real)
cd node && npm i && npm test

# Python — pytest (smoke, error_matrix, conformance, e2e_real)
cd py && pip install -e ".[dev]" && pytest

# Go — go test (mock store, no FFI needed; conformance runner; e2e real needs the FFI dll)
cd go && go test ./...
```

All three smoke suites run on a mock store — no real database and no rust-core binding
required; the semantic truth lives in `spec/`, and `conformance/` holds the shared
cases. The `conformance/` runners are already landed on all three runtimes
(`node/test/conformance.test.js`, `py/tests/test_conformance.py`,
`go/conformance_test.go`): the same JSON case and the same `expect` contract
(`dataKeys` / `gql` / `paramsLimit` / `errorCodePrefix`), run inside the ordinary
`npm test` / `pytest` / `go test`. Real-database e2e suites skip explicitly when their
dependencies (host package, driver, or FFI dll) are missing — never silently.

**The parity rule:** change `spec/` first, then the three implementations, and finally
add the conformance case. If the three disagree, that is a defect.

## Related projects

- [`store-api`](https://github.com/coenddt/store-api) — the RESTful skin over the same
  data layer; shares the same JSON schema as the single source of truth.
- [`store-gateway`](../store-gateway) — composes the protocol skins behind one entry
  point (`graphqlPlugin` is a unified entry for the host and the gateway).
- Hosts: `nodejs-store` (npm), `py-store` (PyPI), `go-store` (Go) — the three runtime
  bindings this adapter serves.
- Engine: `rust-store` — the IO-free Rust core (GQL parsing / permissions / computed
  columns / command planning / SQL dialects) whose semantics every skin inherits.
- Control plane & scaffolding: `meta-store`, `create-store-app`,
  `store-rbac-bootstrap`, `store-resource-bootstrap`.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 丁滔.
