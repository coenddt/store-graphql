# store-graphql

为 common-store 数据层家族（nodejs-store / py-store / go-store）自动生成**标准 GraphQL** API 的三端适配层。

> 英文索引：[README.md](./README.md)

- Node：graphql-js + GraphQL Yoga 适配器（`store-graphql-node`，npm）
- Python：graphql-core + FastAPI 适配器（`store-graphql-py`，PyPI）
- Go：graphql-go + net/http 适配器（`store-graphql-go`，`go/` 下，服务 go-store 宿主）
- 共享：`spec/`（SDL 生成 / 执行映射 / 自定义 / 错误与上下文的唯一事实源）+ `conformance/`（跨运行时一致性用例）

设计规则：**GraphQL 只是 GQL 的又一层 HTTP 皮肤** —— 适配层零语义发明；一切映射到 store 既有的 schema / GQL / RBAC 语义，经**投影下推**一次查询取整棵数据（无 N+1）。

**对外部署**：生产清单（上下文 fail-open 对策、网关配置、错误前缀告警表）见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

姊妹仓库：[store-api](https://github.com/coenddt/store-api)（同一数据层的 RESTful 皮肤，共享同一份 JSON schema 事实源）。

## 快速上手

### Node（`store-graphql-node`）

```js
const { createServer } = require('node:http');
const { init, store } = require('nodejs-store');
const { createYoga, exportSDL } = require('store-graphql-node');

await init(db);
store.register(defn);                       // 纯 JSON schema，注册即得
const { yoga, schema } = createYoga(store); // 含 GraphiQL；schema 可单独持有
createServer(yoga).listen(4000);            // http://localhost:4000/graphql

exportSDL(schema);                          // 落盘喂 @graphql-codegen
```

### Python（`store-graphql-py`）

```python
from py_store import init, store
from store_graphql import build_graphql_schema, create_app, export_sdl

await init(db)
store.register(defn)
schema = build_graphql_schema(store)
app = create_app(store, schema=schema)      # FastAPI 单路由；fastapi 为可选依赖
# 或仅拿 schema 自行承载：await graphql(schema, query)

export_sdl(schema)                          # 落盘喂 ariadne-codegen
```

### Go（`store-graphql-go`）

```go
st, _ := gostore.Open("app.db")
_ = st.Register(defn)
schema, _ := storegraphql.Build(st, storegraphql.Options{
    Schemas: []map[string]any{defn},        // go-store 不回读 defn，与 Register 共用同一份
})
mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
```

## 自动生成的机制

1. **生成源唯一**：store 的纯 JSON schema（与 REST 皮肤 store-api 同源）
2. **生成面**：每模型 `get_X` / `list_X`（Query）+ `create_X` / `update_X` / `delete_X`（Mutation），字段类型按 defn 反射映射（嵌套 object 下钻，动态结构走 `JSON` 标量）
3. **投影下推**：GraphQL selection 被序列化回现有 GQL 投影串，一次 `store.query` 取整棵数据——关系子查询 / 聚合 / 计算列 / RBAC / 方言路由全量继承 core 链路
4. **SDL 出口**：`exportSDL()` / introspection → 喂 `@graphql-codegen` / `ariadne-codegen` / genqlient
5. **`__` 前缀内建模型过滤**：core 控制面内建模型以 `__` 前缀命名（`__schemaDef` / `__workflowRun` 等）；`__` 为 GraphQL 规范保留（introspection），故无条件过滤出 schema、对外不可查询（该过滤为 GraphQL 皮专有约束，含显式 resources 入参）

## 自动生成之后如何自定义（四钩子，按侵入度递增）

| 钩子 | 做法 | SDL 影响 |
|---|---|---|
| 1. 注记 | defn 上 `"x-graphql": {"hidden": true}` / `{"readonly": true}` | 整模型隐藏 / 只出 Query |
| 2. override | `overrides: {"Query.list_User": myResolver}` 按路径替换 | 不变，只换行为 |
| 3. extend | `extensions: {"Query": {...自定义字段}}` | 同步追加字段 |
| 4. 逃生舱 | `exportSDL()` 手改后按 schema-first 重载（Ariadne / gqlgen 等） | 完全接管 |

详见 [spec/03-customization.md](./spec/03-customization.md)。

## 文档系统（spec/05，三层）

1. **description 管道**：defn 的 `description` 键（模型级/字段级，JSON Schema 惯例）原样写入 SDL——introspection / GraphiQL / codegen 全链路携带，适配层透传不改写
2. **交互式 Explorer**：node 由 Yoga 原生提供 GraphiQL；py / go 的 `GET /graphql` 返回 GraphiQL 文档页（`POST` 才执行查询）
3. **静态文档站**：`exportSDL()` 是唯一出口，推荐 SpectaQL / graphql-markdown 消费，适配层不自造文档生成器

## 错误与上下文

- 权限类错误（core 稳定前缀 `ERR_PERMISSION:`，以及权限类同档的 `NoContext`——machine code `no_context` / 前缀 `ERR_NO_CONTEXT:`）⇒ HTTP **403** + `extensions.code: FORBIDDEN`；其余上下文错误 ⇒ **401**。按类型 / 机器码判定，禁按文案匹配。详见 [spec/04-errors-context.md](./spec/04-errors-context.md)。

## v0 范围与明确不支持项

- 支持：Query `get_X` / `list_X`（condition/sort/limit，**limit 缺省 50、上限 1000、超限抛 `ERR_LIMIT:` 错误**——core 的行数封顶仅 text2query 档生效，适配层守上界，见 spec/02），Mutation `create_X` / `update_X` / `delete_X`；introspection；fragments 与 `@skip`/`@include`（node/py/go 均实现）
- 不支持：subscription（store 无订阅语义）；输出别名（alias）、偏移分页（`$skip`）、`count_X` 聚合根——待 core 语义核实后 v1 收编（见 spec/01、spec/02 的「待核实」）
- go 端 v0 差异：`JSON` 标量的内联字面量以非空校验拦截（graphql-go 的 ParseLiteral 无 error 通道），见 spec/02

## 开发

```bash
node: cd node && npm i && npm test          # 7 用例
python: cd py && pip install -e ".[dev]" && pytest   # 7 用例
go: cd go && go test ./...                  # 4 用例（mock store，无需 FFI）
```

三端 smoke 均跑在 mock store 上，不依赖真实库与 rust core 绑定；语义一致性以 `spec/` 为准，`conformance/` 存共享用例（v1 接三端 runner）。
