# store-graphql

Standard GraphQL API auto-generation for the common-store data layer family (nodejs-store / py-store / go-store).

> 中文文档（主文档）：[README.zh-CN.md](./README.zh-CN.md)

- Node: graphql-js + GraphQL Yoga adapter (`store-graphql-node`, npm)
- Python: graphql-core + FastAPI adapter (`store-graphql-py`, PyPI)
- Go: graphql-go + net/http adapter (`store-graphql-go`, under `go/`, serving the go-store host)
- Shared: `spec/` (single source of truth for SDL generation / execution mapping / customization / errors & context) + `conformance/` (cross-runtime parity cases)

Design rule: **GraphQL is just another HTTP skin over GQL** — the adapters invent zero semantics of their own; everything maps onto store's existing schema / GQL / RBAC semantics, with projection pushdown (no N+1).

## Customization hooks (after auto-generation)

1. **Annotations** — `"x-graphql": {"hidden": true}` / `{"readonly": true}` on the schema defn
2. **Override** — swap any generated resolver by path (`Query.list_User`), SDL unchanged
3. **Extend** — append custom fields to Query/Mutation, SDL follows
4. **Escape hatch** — `exportSDL()` → edit → reload schema-first; the generator output is a starting point, not a cage

See [spec/03-customization.md](./spec/03-customization.md).
