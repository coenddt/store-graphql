"""store-graphql-py — 为 py-store 已注册 schema 自动生成标准 GraphQL API。

语义依据：../../spec/*.md（多端 parity，改动先改 spec）。
设计哲学：GraphQL 只是 GQL 的又一层 HTTP 皮 —— 适配层零语义发明。

分层：
    build_graphql_schema(store, **opts) → 纯 graphql-core GraphQLSchema
    create_app(store, **opts)           → FastAPI 应用（可选依赖 fastapi）
    export_sdl(schema)                  → SDL 字符串（喂客户端 codegen）

store 端口契约见 spec/00：list/get/query/insert/update/remove/set_context。
"""

from .adapter import (
    build_graphql_schema,
    create_app,
    export_sdl,
    filter_archived,
)

__all__ = [
    "build_graphql_schema",
    "create_app",
    "export_sdl",
    "filter_archived",
]
