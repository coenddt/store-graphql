# store-graphql

Standard GraphQL API auto-generation for the common-store data layer family (nodejs-store / py-store / go-store).

> 中文文档（主文档）：[README.zh-CN.md](./README.zh-CN.md)

- Node: graphql-js + GraphQL Yoga adapter (`store-graphql-node`, npm)
- Python: graphql-core + FastAPI adapter (`store-graphql-py`, PyPI)
- Go: graphql-go + net/http adapter (`store-graphql-go`, under `go/`, serving the go-store host)
- Shared: `spec/` (single source of truth for SDL generation / execution mapping / customization / errors & context) + `conformance/` (cross-runtime parity cases)

Design rule: **GraphQL is just another HTTP skin over GQL** — the adapters invent zero semantics of their own; everything maps onto store's existing schema / GQL / RBAC semantics, with projection pushdown (no N+1).

**Going to production?** See [DEPLOYMENT.md](./DEPLOYMENT.md) — context fail-open countermeasures, built-in guards (body 1MB / limit 50·1000 / depth 10 / fields 300 / introspection switch), gateway reference config, and the error-prefix alerting table.

## Quick start

### Node (`store-graphql-node`)

```js
const { createServer } = require('node:http');
const { init, store } = require('nodejs-store');
const { createYoga, exportSDL } = require('store-graphql-node');

await init(db);
store.register(defn);                       // plain JSON schema — register and go
const { yoga, schema } = createYoga(store); // GraphiQL included; schema can be held separately
createServer(yoga).listen(4000);            // http://localhost:4000/graphql

exportSDL(schema);                          // write to disk for @graphql-codegen
```

### Python (`store-graphql-py`)

```python
from py_store import init, store
from store_graphql import build_graphql_schema, create_app, export_sdl

await init(db)
store.register(defn)
schema = build_graphql_schema(store)
app = create_app(store, schema=schema)      # FastAPI single route; fastapi is optional
# or hold the schema and serve it yourself: await graphql(schema, query)

export_sdl(schema)                          # write to disk for ariadne-codegen
```

### Go (`store-graphql-go`)

```go
st, _ := gostore.Open("app.db")
_ = st.Register(defn)
schema, _ := storegraphql.Build(st, storegraphql.Options{
    Schemas: []map[string]any{defn},        // go-store does not read defn back; shares the same one as Register
})
mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
```

## How generation works

1. **Single generation source**: the store's plain JSON schema (same source as the REST skin store-api)
2. **Surface**: per model `get_X` / `list_X` (Query) + `create_X` / `update_X` / `delete_X` (Mutation); field types are reflected from the defn (nested objects walked down, dynamic structures as the `JSON` scalar)
3. **Projection pushdown**: the GraphQL selection is serialized back into the existing GQL projection string — one `store.query` fetches the whole tree; relation subqueries / aggregation / computed columns / RBAC / dialect routing all inherited from core
4. **SDL exit**: `exportSDL()` / introspection → feed `@graphql-codegen` / `ariadne-codegen` / genqlient
5. **`__`-prefix built-in models filtered**: core's control-plane built-in models are named with a `__` prefix (`__schemaDef` / `__workflowRun` / …); `__` is reserved by the GraphQL spec (introspection), so they are unconditionally filtered out of the schema and never exposed for query

## Customization hooks (after auto-generation)

1. **Annotations** — `"x-graphql": {"hidden": true}` / `{"readonly": true}` on the schema defn
2. **Override** — swap any generated resolver by path (`Query.list_User`), SDL unchanged
3. **Extend** — append custom fields to Query/Mutation, SDL follows
4. **Escape hatch** — `exportSDL()` → edit → reload schema-first; the generator output is a starting point, not a cage

See [spec/03-customization.md](./spec/03-customization.md).

## Documentation system (spec/05, three layers)

1. **description pipeline** — `description` keys on the defn (model & field level, JSON-Schema style) flow verbatim into SDL; carried by introspection / GraphiQL / codegen
2. **Interactive explorer** — Yoga ships GraphiQL on Node; py / go serve a GraphiQL page on `GET /graphql` (queries execute via `POST`)
3. **Static docs** — `exportSDL()` is the single exit; feed SpectaQL or graphql-markdown, no doc-site generator in the adapters

## Errors & context

- Permission-class errors (core stable prefix `ERR_PERMISSION:`, plus the permission-class peer `NoContext` — machine code `no_context` / prefix `ERR_NO_CONTEXT:`) ⇒ HTTP **403** + `extensions.code: FORBIDDEN`; any other context error ⇒ **401**. Matched by type / machine code, never by message text. See [spec/04-errors-context.md](./spec/04-errors-context.md).

## v0 scope and explicit non-goals

- Supported: Query `get_X` / `list_X` (condition/sort/limit, **limit defaults to 50, caps at 1000, over-limit throws `ERR_LIMIT:`** — core's row cap only applies to the text2query profile; the adapter enforces the upper bound, see spec/02), Mutation `create_X` / `update_X` / `delete_X`; introspection; fragments and `@skip`/`@include` (implemented on node/py/go)
- Not supported: subscription (store has no subscription semantics); output alias, skip-offset paging (`$skip`), `count_X` aggregation root — to be adopted in v1 after core semantics are confirmed (see the "to be verified" notes in spec/01, spec/02)
- go v0 difference: inline literals of the `JSON` scalar are rejected with a non-null validation error (graphql-go's ParseLiteral has no error channel), see spec/02

## Development

```bash
node: cd node && npm i && npm test          # 7 cases
python: cd py && pip install -e ".[dev]" && pytest   # 7 cases
go: cd go && go test ./...                  # 4 cases (mock store, no FFI needed)
```

All three smoke suites run on a mock store, without a real database or the rust-core binding; semantic truth lives in `spec/`, and `conformance/` holds the shared cases (v1 wires the three runners).
