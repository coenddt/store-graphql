# store-graphql

Standard GraphQL API auto-generation for the common-store data layer family (nodejs-store / py-store / go-store).

> 中文文档（主文档）：[README.zh-CN.md](./README.zh-CN.md)

- Node: graphql-js + GraphQL Yoga adapter (`store-graphql-node`, npm)
- Python: graphql-core + FastAPI adapter (`store-graphql-py`, PyPI)
- Go: graphql-go + net/http adapter (`store-graphql-go`, under `go/`, serving the go-store host)
- Shared: `spec/` (single source of truth for SDL generation / execution mapping / customization / errors & context) + `conformance/` (cross-runtime parity cases)

Design rule: **GraphQL is just another HTTP skin over GQL** — the adapters invent zero semantics of their own; everything maps onto store's existing schema / GQL / RBAC semantics, with projection pushdown (no N+1).

**Going to production?** See [DEPLOYMENT.md](./DEPLOYMENT.md) — context fail-open countermeasures, built-in guards (body 1MB / limit 50·1000 / depth 10 / fields 300 / introspection switch), gateway reference config, and the error-prefix alerting table.

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
