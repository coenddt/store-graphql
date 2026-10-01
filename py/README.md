# store-graphql-py

GraphQL adapter that auto-generates standard GraphQL APIs for **py-store** schemas (schema-driven CRUD over GQL, projection pushdown).

```python
from store_graphql import build_graphql_schema, create_app, export_sdl

schema = build_graphql_schema(store)      # 反射 py-store 已注册的 JSON schema
app = create_app(store, schema=schema)    # FastAPI 承载（可选依赖）；或 graphql(schema, query) 自行执行
export_sdl(schema)                        # SDL 导出，喂客户端 codegen
```

完整文档（双语主文档 / spec / conformance）：见仓库根 [README.zh-CN.md](https://github.com/coenddt/store-graphql#readme)。
