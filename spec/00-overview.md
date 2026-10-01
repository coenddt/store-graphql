# 00 — 总览

`store-graphql` 为 common-store 数据层家族（nodejs-store / py-store / go-store）自动生成**标准 GraphQL** API。

## 设计规则（与 store-api 同源）

> **GraphQL 只是 GQL 的又一层 HTTP 皮肤** —— 适配层零语义发明：凡 store 没有的语义，本层一律不提供；凡 store 已有的语义（RBAC / 计算列 / 关系子查询 / 方言路由），本层经投影下推全量继承。

- 生成源是 store 的**纯 JSON schema**（唯一事实源，与 REST 皮肤 store-api 同源）
- 适配层不引入第二套类型定义、不重复实现权限、不缓存业务数据
- 三端语义以本 `spec/` 目录为唯一依据，**改动先改 spec，再三端实现，最后补 conformance 用例**——三者不一致即为缺陷

## 三端形态

| 端 | 目录 | 包名 | schema 构建 | HTTP 承载 | 执行器 |
|---|---|---|---|---|---|
| Node | `node/` | `store-graphql-node`（npm） | graphql-js 程序化 `GraphQLSchema` | GraphQL Yoga（可挂任意框架或独立跑） | graphql-js `execute`（Yoga 内置） |
| Python | `py/` | `store-graphql-py`（PyPI） | graphql-core 程序化 `GraphQLSchema` | FastAPI 单路由（可选，缺省仅产 schema） | graphql-core `graphql()`（async） |
| Go | `go/` | `store-graphql-go`（module `github.com/coenddt/store-graphql-go`） | graphql-go/graphql 程序化 `graphql.Schema` | 标准库 `net/http` | graphql-go `graphql.Do` |

## 适配层依赖的 store 端口（契约）

三端适配层只依赖以下 store 公开方法（鸭子类型 / Go interface，**不 import 具体 store 类型做运行时绑定**；Go 端接口签名对齐 `gostore.Store` 实际方法，出处 `go-store/store.go`）：

| 能力 | nodejs-store | py-store | go-store |
|---|---|---|---|
| 列模型名 | `store.list()` → `string[]` | `store.list()` → `list[str]` | 显式传入（`Options.Schemas`，go-store 不回读 defn） |
| 取模型 defn | `store.get(name)` | `store.get(name)` | 同上（defn 即传入物） |
| GQL 查询 | `store.query(gql, params)` | `store.query(gql, params)` | `Query(ctx, gql, params, actx)` |
| 写入 | `store.insert/update/remove(...)` | `store.insert/update/remove(...)` | `Insert/Update/Remove(ctx, ...)` |
| 上下文 | `store.setContext(ctx)` | `store.set_context(ctx)` / `setContext` | 显式 `actx` 参数（`*gostore.Context`） |

（出处：`nodejs-store/src/index.js:101-117,287`；`py-store/src/py_store/__init__.py:97-114,227-229`；`go-store/store.go:164-559`）

## v0 范围与明确不支持项

- Query：`get_X` / `list_X`；Mutation：`create_X` / `update_X` / `delete_X`
- **不支持**：subscription（store 无订阅语义）；`count_X` 聚合根、输出别名（alias）、`skip` 分页偏移——均待 core 侧语义核实后 v1 收编（见 01/02 的「待核实」）
