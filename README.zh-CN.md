# store-graphql

为 common-store 数据层家族（`nodejs-store` / `py-store` / `go-store`）的纯 JSON
schema 自动生成**标准 GraphQL API** 的三端适配层。

> **GraphQL 只是 GQL 之上的又一层 HTTP 皮肤。** 适配层零语义发明——每个字段都映射到
> store 既有的 schema / GQL / RBAC / 关系 / 计算列语义，并带**投影下推（无 N+1）**。

英文索引：[README.md](./README.md)

**即将上线生产？** 见 [DEPLOYMENT.md](./DEPLOYMENT.md)——上下文 fail-open 对策、内建护栏
（body 1MB / limit 50·1000 / depth 10 / fields 300 / introspection 开关）、网关参考配置，
以及错误前缀告警表。

## 运行时矩阵

| 运行时 | 包名 | Schema 构建 | HTTP 承载 | 执行器 | 分发渠道 |
|---|---|---|---|---|---|
| Node | `store-graphql-node` | graphql-js 编程式 `GraphQLSchema` | `createYoga(store, opts)` → fetch handler；`graphqlPlugin(fastify, opts)`（默认 `/graphql`，`path` 可配） | graphql-js `execute`（经 GraphQL Yoga） | **npm** |
| Python | `store-graphql-py` | graphql-core 编程式 `GraphQLSchema` | FastAPI 单路由（可选；不带它则只拿到 schema） | graphql-core `graphql()`（异步） | **PyPI** |
| Go | `store-graphql-go` | graphql-go/graphql 编程式 `graphql.Schema` | 标准库 `net/http`（`Handler(schema, opts)`） | graphql-go `graphql.Do` | 仓内（`go/`） |

**Go v0 差异（如实列出）：**

- `go-store` **不**回读 defn，因此你必须通过 `Options.Schemas` 传入同一份 defn 列表
  （与 `gostore.Register` 共用）。
- v0 无离线 SDL 导出器——SDL 由标准 **introspection** 定义（端点自带）。
- v0 未实现 fragment 展开；携带 fragment 的请求按字段逐个投影，字段缺失时 Go 适配层
  回退到已注册 defn 的全字段键投影。
- `JSON` 标量的内联字面量被拒（graphql-go 的 `ParseLiteral` 没有 error 通道，只能返回
  `nil`，随后被非空参数校验拦截）——JSON 必须走 variables。

其余一切（SDL 命名、`limit` 守卫、`__` 前缀过滤、错误 → HTTP 状态映射、护栏阈值）
在**三端完全一致**，事实源在 [`spec/`](./spec) 与共享的 [`conformance/`](./conformance)
用例中。

## 目录

- [它是什么](#它是什么)
- [何时使用 / 何时不使用](#何时使用--何时不使用)
- [安装](#安装)
- [快速上手](#快速上手)
  - [Node](#node)
  - [Python](#python)
  - [Go](#go)
- [Schema 生成](#schema-生成)
- [执行映射](#执行映射)
- [定制化钩子](#定制化钩子)
- [错误与上下文](#错误与上下文)
- [场景事例](#场景事例)
- [生产部署](#生产部署)
- [v0 范围与明确不支持项](#v0-范围与明确不支持项)
- [常见问题](#常见问题)
- [开发](#开发)
- [相关项目](#相关项目)
- [许可证](#许可证)

## 它是什么

一层按运行时划分的薄适配器：把你已注册的 store JSON schema 反射为标准 GraphQL schema，
并沿 store 既有的 GQL 链路执行请求。

1. **生成源唯一**——store 的纯 JSON schema（`defn`），与 REST 皮肤 `store-api`
   *同一*来源。适配层不引入第二套类型系统。
2. **生成面**——对每个模型 `X`，在 `Query` 上生成 `get_X` / `list_X`，在 `Mutation` 上生成
   `create_X` / `update_X` / `delete_X`。字段类型由 defn 反射（嵌套 `object` 向下钻取为嵌套
   对象类型；动态结构走 `JSON` 标量）。
3. **投影下推**——GraphQL selection 被序列化回既有 GQL 投影串，于是**一次 `store.query`
   取回整棵树**。关系子查询、聚合、计算列、RBAC、方言路由全部继承自 core。子字段解析器
   只做静态查表。
4. **SDL 出口**——`exportSDL(schema)` / `export_sdl(schema)`（Node / Python）与 introspection
   （全运行时）可供 `@graphql-codegen` / `ariadne-codegen` / genqlient 消费。
5. **`__` 前缀内建模型被过滤**——core 控制面内建模型以 `__` 前缀命名（`__schemaDef` /
   `__workflowRun` / `__workflowDef` / `__feedback`）。`__` 为 GraphQL 规范保留
   （introspection），故它们被**无条件**过滤出 schema、永不对外可查询。该过滤是 GraphQL
   皮专有的（REST / gRPC / MCP 无此规则），因此*不*并入与 `store-api` 逐字节一致的
   `filterArchived` 规则；即使你传入显式 `resources` 列表它依然生效。

### 它依赖的 store 端口契约

适配层只使用以下 store 公有方法（鸭子类型；Go 端对齐 `gostore.Store` 接口——运行绑定不
import 具体 store 类型）：

| 能力 | nodejs-store | py-store | go-store |
|---|---|---|---|
| 列出模型名 | `store.list()` → `string[]` | `store.list()` → `list[str]` | 通过 `Options.Schemas` 显式传入 |
| 取模型 defn | `store.get(name)` | `store.get(name)` | 你传入的同一份 defn |
| GQL 查询 | `store.query(gql, params)` | `store.query(gql, params)` | `Query(ctx, gql, params, actx)` |
| 写入 | `store.insert/update/remove(...)` | `store.insert/update/remove(...)` | `Insert/Update/Remove(ctx, ...)` |
| 上下文 | `store.setContext(ctx)` | `store.set_context(ctx)` | 显式 `actx` 参数 |

## 何时使用 / 何时不使用

**适用场景**

- 你已有 store JSON schema，想要一个可浏览、带类型、自描述的 API，而不必手写 SDL 或
  解析器。
- 前端团队想要 GraphiQL 做探索，以及 codegen 出来的带类型客户端。
- 你需要在一次往返里取回一整棵嵌套树，且在意避免 N+1（移动端、BFF 聚合）。
- 你想要一种声明式方式来收窄 API 暴露面（隐藏内部表、只读审计表），而不动代码。

**不适用场景**

- 你需要实时推送语义（subscription）——store 没有，本皮肤也不会发明。
- 你需要 offset/skip 分页、输出别名，或聚合根 `count_X`——全部推迟到 v1（见
  [v0 范围](#v0-范围与明确不支持项)）。
- 你需要写密集的 GraphQL 批处理——批处理关闭（每请求一份 document）。
- 你想让适配层掌管认证——它不掌管；你注入上下文 provider，其余交给 store 的 RBAC。

## 安装

**Node（npm）**

```bash
npm i store-graphql-node          # 拉入 graphql + graphql-yoga（可选依赖）
npm i fastify                     # 仅当你用 Fastify 插件 graphqlPlugin
npm i nodejs-store                # 宿主数据层（peer，可选）
```

**Python（PyPI）**

```bash
pip install store-graphql-py              # 仅 graphql-core；承载层你自己定
pip install "store-graphql-py[fastapi]"   # 追加 FastAPI 以供 create_app()
pip install py-store                      # 宿主数据层
```

**Go（仓内模块）**

```bash
go get github.com/coenddt/store-graphql-go
```

## 快速上手

### Node

一个可直接运行的端到端示例（对应 `node/test/e2e.real.test.js`——真实 `nodejs-store` +
`better-sqlite3`）：

```js
// quickstart.js — 运行：node quickstart.js
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
  // SQL 源必须是 { kind, exec } 描述符，绝不能传裸驱动实例。
  await init({ default: executors.createConnection('sqlite', db) });
  store.register(DEFN);
  // nodejs-store 从不替你写 DDL；它把 DDL 打印出来，由你执行。
  db.exec(store.generateDdl('sqlite', ['User']));
  db.exec(store.generateDdl('sqlite', ['UserDeleted'])); // 归档表，由 core 自动注册

  const { yoga, schema } = createYoga(store);   // 含 GraphiQL；schema 单独持有
  createServer(yoga).listen(4000);              // http://localhost:4000/graphql

  console.log(exportSDL(schema));               // SDL 字符串 → 落盘喂 codegen
}

main();
```

更偏爱 Fastify？注册插件即可，无需自建裸服务器：

```js
const fastify = require('fastify')({ logger: true });
await fastify.register(require('store-graphql-node').graphqlPlugin, {
  store,
  path: '/graphql',                 // 默认 '/graphql'
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
        # py-store 同样从不替你写 DDL；aiosqlite 的 executescript 是协程。
        await db.executescript(py_store.store.generate_ddl("sqlite", ["User"]))
        await db.executescript(py_store.store.generate_ddl("sqlite", ["UserDeleted"]))

        schema = build_graphql_schema(py_store.store)
        app = create_app(py_store.store, schema=schema)   # FastAPI app；GET /graphql → GraphiQL
        print(export_sdl(schema))                         # SDL 字符串，喂 ariadne-codegen

        # 或者完全跳过 FastAPI，自行执行：
        # from graphql import graphql
        # result = await graphql(schema, "{ list_User { _id name } }")

asyncio.run(main())
```

用 `uvicorn quickstart:app` 承载这个 FastAPI app（或内联 `create_app` 后以编程方式跑
uvicorn）。

### Go

```go
// 完整程序见 go/demo/main.go —— 运行：go run ./demo
st, _ := gostore.Open("sqlite::memory:")
defer st.Close()
_ = st.Register(userDefn)

schema, err := storegraphql.Build(st, storegraphql.Options{
    Schemas: []map[string]any{userDefn}, // go-store 不回读 defn；与 Register 共用同一份
    ContextProvider: func(r *http.Request) (*gostore.Context, error) {
        return nil, nil // 返回 nil 仍会显式注入（清空身份）
    },
})
if err != nil {
    log.Fatal(err)
}

mux := http.NewServeMux()
mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
log.Fatal(http.ListenAndServe(":4000", mux))
```

## Schema 生成

事实源：[`spec/01-schema-generation.md`](./spec/01-schema-generation.md)。

**生成源。** Node / Python 在启动时反射 `store.list()`（归档过滤之后），并对每个模型调用
`store.get(name)`。Go 用你在 `Options.Schemas` 里传的 defn 列表——`gostore.Register(defn)`
不回读它，因此适配层与注册共用同一份副本。

**资源过滤（与 `store-api` 一致）。** 名字以 `Deleted` 结尾、且其基名*也在*列表中的，
是归档表，不生成任何类型或字段（`User` + `UserDeleted` → 只有 `User`）。显式 `resources`
列表按同一规则过滤。

**类型映射**（`defn.fields.*.type` → GraphQL 输出类型）：

| defn `type` | GraphQL 类型 | 说明 |
|---|---|---|
| `string` / `datetime` | `String` | v0 中 datetime 以 ISO 字符串原样透传；无自定义标量 |
| `int` | `Int` | |
| `float` | `Float` | |
| `bool` | `Boolean` | |
| `object`（带 `fields`） | 名为 `<ParentType>_<fieldPath>` 的嵌套 `ObjectType` | 向下递归 |
| `object`（无 `fields`）/ `array` / 未知类型 | `JSON`（自定义标量） | 最小诚实承诺——绝不丢弃语义 |

- `_id` → `ID!`（非空）。**其余字段一律可空**——缺省值缺失或被权限裁剪都可能产生 `null`，
  故适配层不做无根据的非空承诺。
- `computes.*` 视作字段并入类型（同一映射；在课程平台 defn 中每个 `compute` 自带 `type`）。

**生成面。**

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

对于上面的 `User` defn，`exportSDL(schema)` 打印（节选）：

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

**`JSON` 自定义标量。** 它承载任意 JSON 值——用于 `condition`、`sort`、`input` 与 `set`。
它**只接受 variables**；内联字面量在三端均被拒（Node 的 graphql-js 与 Python 的
graphql-core 在 `parseLiteral` 抛错；Go 的 `ParseLiteral` 返回 `nil`，被非空校验拦截）。

**`description` 管道。** `defn.description` 与 `fieldDefn.description`（JSON Schema 惯例）
原样写入 SDL 三引号注释——模型级、字段级、计算列级、嵌套对象级——适配层只透传、从不改写。
见 [`spec/05-documentation.md`](./spec/05-documentation.md)。

**SDL 导出。** Node：`exportSDL(schema)`（`printSchema`）。Python：`export_sdl(schema)`
（`print_schema`）。Go：v0 无离线导出器；SDL 由 introspection 定义。

> **待核实（v1）：** offset 分页的真实 core 参数名（`$skip` / `$page`）——未确认前
> `list_X` 不暴露 offset 参数（宁可不写，也不发明）。`count_X` 聚合根（`QueryWithCount`，
> Go 端已有）需要 Node/Python 等价物——未确认前不生成。

## 执行映射

事实源：[`spec/02-execution-mapping.md`](./spec/02-execution-mapping.md)。

核心策略：**投影下推**。根解析器把 GraphQL selection 序列化回既有 GQL 投影串，发出单次
`store.query`——无 N+1，关系 / 聚合 / 计算列 / 权限 / 方言全部沿用原 core 链路。

**Query → GQL 串。**

| GraphQL 参数 | GQL 片段 | params 键 | 追加时机 |
|---|---|---|---|
| `condition` | `$condition:@c0` | `c0` | 仅当非 null |
| `sort` | `$sort:@s1` | `s1` | 仅当非 null |
| `limit` | `$limit:@l` | `l` | 总是（见 limit 守卫） |

- `get_X(id)` ⇒ `X($condition:@c0) { <projection> }`，其中 `c0 = {"_id": id}`；返回首行，
  为空则 `null`。
- `list_X(...)` ⇒ 上述参数头（按需）+ `{ <projection> }`。
- 主键字段名 `id_field` 在 v0 固定为 `_id`（与 `store-api spec/01` 一致；参数面不变）。

**limit 守卫（适配层语义）。** core 的行数封顶（`clamp_t2q_limit` / `force_t2q_limit`）仅对
`text2query` 档生效；默认 `standard` 档原样返回行。GraphQL 端点用默认档，故无守卫时
`limit` 会取全表。因此解析器：

- **缺省 `limit: 50`**（总是发出 `$limit:@l`），且
- **显式 `limit > 1000` 时抛错**，消息前缀固定为 **`ERR_LIMIT:`**，供客户端识别。这遵循
  「允许被拦截、禁止静默失守」——绝不静默截断。

`limit ≤ 0` 与非整数原样传给 core；其含义属于 core（适配层不发明）。数字（缺省 50、上限
1000）是适配层常量——先改 spec，再改三端。

**Mutation 语义。**

| 操作 | store 调用 | 返回 |
|---|---|---|
| `create_X` | `insert(X, input)` | 插入后的完整文档 |
| `update_X` | `update(X, {"_id": id}, set)`，随后按 selection 回读 | 回读文档（不依赖 `update` 的返回形状；三端一致） |
| `delete_X` | `remove(X, {"_id": id})` | `true`（失败走错误通道） |

**Selection → 投影串**（Node / Python 做精确下推）：

1. `FIELD` ⇒ `name`，若存在嵌套再追加 `{ }`。**v0 忽略输出别名**（按字段名输出；core 的
   GQL 投影无别名语义）。
2. `InlineFragment` ⇒ 就地展开其 selection set。
3. `FragmentSpread` ⇒ 查 `info.fragments` 后递归。
4. `@skip` / `@include` ⇒ 序列化时求值（`if` 从 `info.variableValues` 读取；自定义序列化
   绕过了执行器的指令过滤，故须自己求值）。
5. 空投影兜底 ⇒ 序列化结果为空时回退到 `_id`，保证 GQL 串有效。

**分页。** 无 offset/skip 分页、无游标（`$skip` / `$page` 是 v1 的「待核实」项）。`list_X`
受 `limit` 约束（缺省 50，硬上限 1000）。

**Go v0 差异。** 投影序列化直接读 `ResolveParams.Info.FieldASTs`；未实现 fragment 展开
（v1），故带 fragment 的请求按字段逐个投影，字段缺失时 Go 回退到已注册 defn 的全字段键
投影。

## 定制化钩子

自动生成不是牢笼。四个钩子，按侵入度递增；全部是官方适配器 API。事实源：
[`spec/03-customization.md`](./spec/03-customization.md)。

### 钩子 1 —— 注记（声明式，不改代码）

在 defn 上加 `x-graphql` 键：

```json
{ "name": "SecretLog",  "x-graphql": { "hidden":   true }, "fields": { "...": {} } }
{ "name": "AuditEvent", "x-graphql": { "readonly": true }, "fields": { "...": {} } }
```

- `hidden` —— 整个模型不进 SDL（内部 / 敏感表）。
- `readonly` —— 只出 Query 面（审计 / 日志表；store RBAC 仍独立生效——注记只是收窄
  GraphQL 面）。
- v0 无字段级注记（输入是 `JSON` 标量，SDL 上无处表达；写入裁剪属于 store RBAC——
  `fields.role.read: ["admin"]` 已在 core 中强制）。

### 钩子 2 —— override（换行为，留 SDL）

按字段路径替换生成解析器；生成面保持不变：

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

路径形如 `Query.<field>` / `Mutation.<field>`，与生成面一一对应；未命中路径用默认解析器。
**未知路径是构建期错误**——绝不静默忽略。

### 钩子 3 —— extend（加字段，SDL 随动）

向 `Query` / `Mutation` 追加自定义字段（任意类型，可用 `JSON` 标量）：

```js
// Node：一个跨模型业务字段；内部仍是 store 语义
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

Python：`extensions={"Query": {...}}`。Go：`Extensions map[string]graphql.Fields`（键
`Query` / `Mutation`）。扩展字段在 SDL 与 introspection 中与生成字段**处于同一层级**，
故客户端工具等同对待。`Query` / `Mutation` 之外的扩展键是构建期错误。

### 钩子 4 —— 逃生舱（schema-first 接管）

用 `exportSDL(schema)` 导出 SDL → 手工编辑 → 以 schema-first 模式重载。生成器产物是起点，
不是牢笼：

- Node：`makeExecutableSchema`（graphql-tools），或把 SDL 喂给任意执行器。
- Python：Ariadne（SDL-first 框架）。
- Go：gqlgen（由 SDL 生成 Go，脱离运行时反射路线）。

走逃生舱之后，override/extend 钩子不再适用（类型已离开本适配器生命周期），但 store 调用
仍走同一个 `store.query`——语义未被绕过。

**约束（保护 parity）。** 自定义解析器可调用任意 store 公有语义
（query/insert/update/remove/native 命令），但不得绕过 RBAC 上下文注入。

## 错误与上下文

事实源：[`spec/04-errors-context.md`](./spec/04-errors-context.md)。

**错误通道。** store 错误进入标准 GraphQL `errors` 数组，消息**原样透传**——绝不吞掉、
改写或做跨语义兜底。`data` 与 `errors` 按 GraphQL 原生语义并存（列表部分失败会把该字段置
null 并记录错误）。成功响应必须不含错误文案，解析器返回值*就是*数据——无成功/失败包装。

**上下文（与 `store-api spec/04` 同一范式）。** `ContextProvider` 钩子把 HTTP 请求映射为
store 用户上下文：

| 运行时 | 钩子 | 注入 |
|---|---|---|
| Node | `opts.contextFactory({ request, serverContext })` | `store.setContext(ctx)` |
| Python | `context_provider(request)`（支持 async） | `store.set_context(ctx)` |
| Go | `opts.ContextProvider(req)` | `context.WithValue` 携带 `*gostore.Context` |

- provider 返回 `nil` / `None` 也**会被显式注入**——清空语义必须落地，身份绝不跨请求泄漏。
- provider 抛出权限类错误 ⇒ **403**；其余 ⇒ **401**（消息透传）。

**错误 → HTTP 状态矩阵**（可编程区分；由 `node/test/error-matrix.test.js` 与
`py/tests/test_error_matrix.py` 验证）：

| 错误类别 | 判定 | HTTP | `extensions.code` |
|---|---|---|---|
| RBAC 拒绝 | core 稳定前缀 `ERR_PERMISSION:` | **403** | `FORBIDDEN` |
| 缺上下文 | 机器码 `no_context` / `NoContextError` / 前缀 `ERR_NO_CONTEXT:` | **403** | `FORBIDDEN` |
| 其余上下文错误 | 其他一切 | **401** | — |
| 其余解析器错误 | 消息原样透传 | **200** + `errors` | — |

权限类错误按**类型 / 机器码 / 稳定前缀判定，绝不按消息文案**。Node 端默认 Yoga mask 保留
消息并追加 403 + `FORBIDDEN` extension；Python / Go 在 HTTP 层发出 `FORBIDDEN` 等价状态。

**GraphQL over HTTP。**

- `POST application/json`，载荷 `{ query, variables, operationName }` ⇒ 返回
  `application/json`。
- `GET /graphql` 返回 GraphiQL 文档页。GET 执行查询（`?query=&variables=`）推迟到 v1。
- introspection 是执行器原生能力且**默认开启**（SDL / GraphiQL / codegen 都依赖它）；生产
  可关闭。

**请求体上限。** 三端均为 1MB（对齐 `store-api` 先例 `io.LimitReader(r.Body, 1<<20)`）。
Go 截断后解码失败 ⇒ 400；Python ⇒ 413；Node 设 Yoga 的 `maxRequestBodySize: 1MB`（Yoga
默认 25MB）⇒ 413。

**v0 安全模型。** 一切用户输入（`id` / `condition` / `sort` / `limit` / `input` / `set`）走
params 值通道——零字符串拼接进 GQL。模式在 core 的 IR 层强制。上下文隔离用 py ContextVar /
node AsyncLocalStorage / go 显式 `actx`。按请求的深度、字段数、introspection 护栏见
[生产部署](#生产部署)。

## 场景事例

每个场景都使用 `User` defn（`{ _id, name, age, profile { bio } }`），因此下文查询中的每个
类型名与字段名都直接来自本仓库源码与
[`conformance/cases/users-graphql.json`](./conformance/cases/users-graphql.json)。

### 1. 一次往返取回嵌套树（无 N+1）

**业务背景。** 一个资料页需要一次拿到用户及其嵌套 profile；朴素的「每字段一个解析器」设计
会对每行再发一次查询。

**请求。**

```graphql
query($c: JSON, $l: Int) {
  list_User(condition: $c, limit: $l) {
    _id
    name
    profile { bio }
  }
}
```

Variables：`{ "c": { "name": "a" }, "l": 10 }`

**适配层内部做的事**——selection 被下推为单条 GQL 投影（精确串取自 `node/test/smoke.test.js`）：

```
User($condition:@c0,$limit:@l) { name, profile { bio } }
params = { c0: { name: "a" }, l: 10 }
```

**响应。**

```json
{
  "data": {
    "list_User": [
      { "_id": "u1", "name": "a", "profile": { "bio": "hello" } }
    ]
  }
}
```

**优势所在。** 一次 `store.query` 取回整棵树；defn 的每一层嵌套成为嵌套 GraphQL 对象类型
（`profile` → `User_profile`），由同一行数据解析——无逐行后续查询，无 N+1。

### 2. 前端 GraphiQL 自助 + introspection

**业务背景。** 一位前端工程师想探索 API、查看字段描述，而不读后端代码。

**请求。** 在浏览器打开 `GET /graphql`——Node 提供 Yoga 自带 landing page；Python 与 Go 返回
内置 GraphiQL HTML 页（查询经 `POST` 执行）。随后跑一次存活检查：

```graphql
{ __typename }
```

**响应。**

```json
{ "data": { "__typename": "Query" } }
```

**优势所在。** schema 浏览器读取 introspection（含每个 `description`），提供自动补全，适配层
零额外配置。

### 3. 用 `@graphql-codegen` 生成带类型的 TypeScript 客户端

**业务背景。** 前端想要编译期类型，而非手写 HTTP 调用。

**第 1 步——导出 SDL（Node）。**

```js
const { exportSDL } = require('store-graphql-node');
require('node:fs').writeFileSync('schema.graphql', exportSDL(schema));
```

**第 2 步——配置 codegen。**

```yaml
# codegen.yml
schema: ./schema.graphql
documents: ./src/**/*.graphql
generates:
  ./src/gql/:
    preset: client
```

**第 3 步——编写 document 并调用。**

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

**优势所在。** SDL 是唯一出口；适配层不自带客户端生成器，故任意标准工具链
（Python 的 `ariadne-codegen`、Go 的 `genqlient`）无需改动即可用。

### 4. BFF 只读聚合

**业务背景。** 一个 backend-for-frontend 想向移动端暴露一次「过滤 + 排序 + 有界」的读取，
而不必建专属端点。

**请求。**

```graphql
query($c: JSON, $s: JSON, $l: Int) {
  list_User(condition: $c, sort: $s, limit: $l) {
    _id
    name
    age
  }
}
```

Variables：`{ "c": { "age": 18 }, "s": { "age": -1 }, "l": 20 }`

**适配层内部做的事：**

```
User($condition:@c0,$sort:@s1,$limit:@l) { _id, name, age }
params = { c0: { age: 18 }, s1: { age: -1 }, l: 20 }
```

**响应。**

```json
{
  "data": {
    "list_User": [
      { "_id": "u1", "name": "a", "age": 30 }
    ]
  }
}
```

**优势所在。** `condition` / `sort` / `limit` 原样映射到 GQL 串，故 RBAC 行过滤、计算列、
方言路由依旧生效——BFF 不获得任何新语义，适配层也不缓存数据。

### 5. 管理端 CRUD

**业务背景。** 一个管理后台负责创建、编辑、删除记录。

**创建。**

```graphql
mutation($input: JSON!) {
  create_User(input: $input) { _id name age }
}
```

Variables：`{ "input": { "name": "alice", "age": 30 } }` → 返回带真实生成 `_id` 的已插入
文档（如 `"u1"`，由 `idPrefix` 加 `u` 前缀）。

**更新（先写再按 selection 回读）。**

```graphql
mutation($id: ID!, $set: JSON!) {
  update_User(id: $id, set: $set) { name age }
}
```

Variables：`{ "id": "u1", "set": { "age": 31 } }` → `{ "update_User": { "name": "alice", "age": 31 } }`

**删除。**

```graphql
mutation { delete_User(id: "u1") }
```

→ `{ "delete_User": true }`；随后 `{ list_User { _id } }` 返回 `[]`。

**优势所在。** 写入复用 store 的 `insert/update/remove`，故归档编排与 RBAC 生效；`update`
刻意回读，使三端无论 `update` 原始返回形状如何都保持一致。

### 6. 隐藏内部模型（`x-graphql.hidden`）

**业务背景。** 一张内部 `SecretLog` 表完全不可经 GraphQL 触达。

**设置。**

```json
{ "name": "SecretLog", "x-graphql": { "hidden": true }, "fields": { "_id": { "type": "string" } } }
```

**验证。** `exportSDL(schema)` 中不含 `SecretLog`，且 `schema.getType('SecretLog')` 为
`undefined`。

**优势所在。** 它就是 defn 上的一个声明式键——不改代码、无逐请求检查——且在构建期强制，故
该模型对 introspection 与 GraphiQL 同样不可见。

### 7. 只读模型（`x-graphql.readonly`）

**业务背景。** 一张审计表可读，但绝不可经 GraphQL 写入。

**设置。**

```json
{ "name": "AuditEvent", "x-graphql": { "readonly": true }, "fields": { "_id": { "type": "string" } } }
```

**验证。** SDL 含 `get_AuditEvent`（与 `list_AuditEvent`），但**没有**
`create_AuditEvent` / `update_AuditEvent` / `delete_AuditEvent`。

**优势所在。** GraphQL 面被声明式收窄，而 store RBAC 继续独立强制——两层独立，无重复逻辑。

### 8. 按路径替换单个解析器

**业务背景。** `list_User` 须返回一个在通用路径之外算出的专门形状，但 schema 不得改变。

**设置（Node）。**

```js
buildGraphQLSchema(store, {
  overrides: {
    'Query.list_User': async () => [{ _id: 'x', name: 'override', age: 0, profile: null }],
  },
});
```

**请求 / 响应。**

```graphql
{ list_User { name } }
```

→ `{ "data": { "list_User": [ { "name": "override" } ] } }`

未命中路径如 `Query.list_Nope` 会让构建抛
`override 路径 "..." 未命中任何生成字段`，而不是静默不做任何事。

**优势所在。** 你在恰好一个路径上换行为，SDL 保持逐字节一致，故客户端与 codegen 不受影响。

### 9. 生产护栏实战

**业务背景。** 端点面向互联网；你需要硬上限，使单个请求无法耗尽内存或开出拒绝服务缺口。

**请求体超过 1MB** → `413`：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4000/graphql \
  -H 'content-type: application/json' --data-binary @huge.json   # 413
```

**超限 `limit`** → HTTP 200，`errors[0].message` 以 `ERR_LIMIT:` 开头：

```graphql
query($l: Int) { list_User(limit: $l) { _id } }   # variables: { "l": 1001 }
```

**过深查询**（depth 11 > 10）→ **HTTP 400**，`errors[0].message` 以 `ERR_DEPTH:` 开头；
**字段过多**（> 300）→ 400 `ERR_COMPLEXITY:`；关闭 introspection 后发 `__schema` 请求 →
400 `ERR_INTROSPECTION:`（裸 `__typename` 仍允许）。

**优势所在。** 每个上限都随适配层下发，并以稳定前缀大声失败——绝不静默截断。

### 10. 权限错误 → 403（而非 401）

**业务背景。** 一次请求 RBAC 失败；客户端必须能区分「被拒」与「认证链路坏了」。

**设置（Node）。**

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

**响应。**

```json
{
  "errors": [
    { "message": "ERR_PERMISSION:无访问权限", "extensions": { "code": "FORBIDDEN" } }
  ]
}
```

HTTP 状态为 **403**。一个通用 provider 故障（如 `上下文钩子故障`）则给出 **401**。

**优势所在。** 分类按稳定前缀 / 机器码 / 类型——绝不按消息文案——故被翻译或改写的消息无法
改变状态码。

## 生产部署

完整清单见 [DEPLOYMENT.md](./DEPLOYMENT.md)。适配层保证*语义*安全（注入面、上下文隔离、
护栏）；*部署*安全是清单的职责。

**1. 上下文（最高优先级）。** core 的信任模型是 **fail-open**：`ctx: None` 意为「跳过权限
检查」（`core/src/permission.rs:9-20`）。没有上下文 provider 时，端点在整库上是匿名读写。
两件必做之事：

| 事项 | Node | Python | Go |
|---|---|---|---|
| 按请求钩子 | `createYoga(store, { contextFactory })`（返回 `null` 仍会清空身份） | `create_app(store, context_provider=...)`（支持 async） | `Handler(schema, Options{ ContextProvider: ... })` |
| fail-secure 开关 | `store.setRequireContext(true)` | `store.set_require_context(True)` | rust 宿主 `store.set_require_context(true)`（go-store 经 FFI） |

开启 fail-secure 后，缺失上下文会在计划入口显式报错。若 fail-secure 已开但未配置上下文
钩子，Node / Python 还会在启动期拒绝装配（`ERR_SECURE_CONFIG`）——快速失败，绝不静默降级。

**2. 内建护栏（无需部署配置）。**

| 护栏 | 默认 | 违反时 | 覆盖方式 |
|---|---|---|---|
| 请求体 | 1MB | 413 / 400 | Node `maxRequestBodySize`（Yoga）；Go `maxBodyBytes`；Python 常量 |
| list limit | 缺省 50 / 上限 1000 | 抛 `ERR_LIMIT:` | spec/02 常量 |
| 查询深度 | 10 | 400 `ERR_DEPTH:` | `maxQueryDepth` / `max_query_depth` / `MaxQueryDepth`（0 = 默认） |
| 查询复杂度 | 300 字段 | 400 `ERR_COMPLEXITY:` | `maxQueryFields` / `max_query_fields` / `MaxQueryFields`（0 = 默认） |
| introspection | 开 | 关闭后，400 `ERR_INTROSPECTION:` | `introspection: false` / `DisableIntrospection: true` |

对外暴露时建议 `introspection: false`（先在私网内导出 SDL 供 codegen）。

**3. 网关（nginx 参考）。** 适配层不做连接级防护；把它放在反向代理之后：

```nginx
server {
  location /graphql {
    limit_req zone=graphql burst=20 nodelay;   # 每 IP 10 r/s，burst 20
    proxy_read_timeout 10s;                    # 切断慢查询
    proxy_pass http://127.0.0.1:4000;
  }
}
# 在 http 块中：limit_req_zone $binary_remote_addr zone=graphql:10m rate=10r/s;
# TLS 在网关终止（适配层只提供明文 HTTP）；CORS 是网关的事。
```

**4. 错误前缀告警表。** 护栏触发是上游异常信号；把它接入告警：

| 前缀 | 含义 | 告警动作 |
|---|---|---|
| `ERR_PERMISSION:` | RBAC 拒绝（core） | 高频 = 权限探测；聚合来源 IP |
| `ERR_LIMIT:` | `limit` 超上限 | 高频 = 客户端分页有 bug |
| `ERR_DEPTH:` | 深度超上限 | 出现即攻击尝试；告警 |
| `ERR_COMPLEXITY:` | 字段数超上限 | 出现即攻击尝试；告警 |
| `ERR_INTROSPECTION:` | 关闭时探测 schema | 出现即侦察；告警 |
| 401 `CONTEXT_ERROR` | 上下文钩子故障 | **立即告警**（认证链路坏了，不是用户错误） |

## v0 范围与明确不支持项

**支持**

- Query：`get_X` / `list_X`，参数 `condition` / `sort` / `limit`
  （**limit 缺省 50、上限 1000、超限抛 `ERR_LIMIT:`**——core 的行数封顶仅对 text2query 档
  生效；适配层守上界，见 `spec/02`）。
- Mutation：`create_X` / `update_X` / `delete_X`。
- introspection；fragments 与 `@skip` / `@include`（Node / Python / Go 均已实现）。
- 注记（`x-graphql.hidden` / `x-graphql.readonly`）、override、extension，以及 schema-first
  逃生舱。

**不支持（明确的非目标）**

- **subscription** —— store 无订阅语义，故本皮肤不发明。
- 输出别名、skip/offset 分页（`$skip`）、`count_X` 聚合根——待 core 语义核实后 v1 收编
  （见 `spec/01` 与 `spec/02` 的「待核实」）。
- 请求批处理——三端均每请求一份 document。
- v0 字段级注记——写入裁剪仍归 store RBAC。

**Go v0 差异。** 无离线 SDL 导出（introspection 即 SDL 源）；未实现 fragment 展开（v1）；
内联 `JSON` 字面量以非空校验错误被拒（`graphql-go` 的 `ParseLiteral` 无 error 通道）。

## 常见问题

**1. 我必须手写 SDL 吗？**
不用。SDL 由你注册的 JSON schema 生成。只有当你想完全接管时，手写 SDL 才是钩子 4 逃生舱。

**2. 为什么 `JSON` 标量拒绝内联字面量？**
`condition` / `sort` / `input` / `set` 可以是任意嵌套 JSON，用 GraphQL 字面量语法表达很别扭。
因此该标量只接受通过 **variables** 传入的值（Hasura 式的务实选择）。内联字面量在三端均被
拒。

**3. 为什么 `limit` 缺省 50、上限 1000？**
core 的行数封顶仅对 `text2query` 档生效，故默认档下省略 `limit` 会取全表。适配层加上上限；
超限抛 `ERR_LIMIT:` 而非静默截断。

**4. 为什么我的 `__` 前缀模型不见了？**
`__` 被 GraphQL 规范保留给 introspection。core 的控制面模型（`__schemaDef`、`__workflowRun`
等）会让整个 schema 失效，故它们被无条件过滤掉。

**5. 我能改命名（`get_User`、`list_User`…）吗？**
命名固定，属跨运行时契约。要重塑它，用钩子 4（改 SDL）或钩子 3（用你自己的名字加字段）。

**6. 支持 subscription 吗？**
不支持——store 无订阅语义，本皮肤不发明。

**7. 支持 offset 分页、别名或 `count_X` 吗？**
v0 不支持。offset 分页的 core 参数名与 Node/Python 的 `QueryWithCount` 等价物仍属「待核实」，
故这些推迟到 v1，而非猜测。

**8. 如何在不改 schema 的前提下定制单个解析器？**
用钩子 2——按路径 override，例如 `overrides: { 'Query.list_User': myResolver }`。

**9. 如何在生产关闭 introspection？**
传 `introspection: false`（Node/Python）或 `DisableIntrospection: true`（Go）。含 `__schema` /
`__type` 的请求随后得到 400 `ERR_INTROSPECTION:`；`__typename` 仍允许。

**10. 为什么有时 403、有时 401？**
基于角色的拒绝（前缀 `ERR_PERMISSION:`，或权限类的 `NoContext`）是 **403**；其余上下文钩子
故障是 **401**。分类按类型 / 机器码 / 前缀，绝不按消息文案。

**11. Go 运行时到底有何不同？**
Schema 生成需要 `Options.Schemas`（go-store 不回读 defn）；无离线 SDL 导出器（introspection
即源）；v0 不展开 fragments；内联 `JSON` 字面量被拒。其余与 Node/Python 一致。

**12. GraphQL 会重新实现 RBAC、计算列或关系吗？**
不会。这些全部经下推的 GQL 投影从 core 继承；本皮肤只反射 schema 并序列化 selection。

## 开发

```bash
# Node —— node:test（smoke、error-matrix、conformance、e2e.real）
cd node && npm i && npm test

# Python —— pytest（smoke、error_matrix、conformance、e2e_real）
cd py && pip install -e ".[dev]" && pytest

# Go —— go test（mock store，无需 FFI；conformance runner；e2e real 需 FFI dll）
cd go && go test ./...
```

三端 smoke 套件均跑在 mock store 上——不依赖真实库与 rust core 绑定；语义真相在 `spec/`，
`conformance/` 存共享用例。`conformance/` runner 已在三端落地
（`node/test/conformance.test.js`、`py/tests/test_conformance.py`、
`go/conformance_test.go`）：同一份 JSON 用例、同一个 `expect` 契约
（`dataKeys` / `gql` / `paramsLimit` / `errorCodePrefix`），在常规 `npm test` / `pytest` /
`go test` 内运行。真实库 e2e 套件在依赖（宿主包、驱动或 FFI dll）缺失时会显式 skip——
绝不静默。

**parity 铁律：** 先改 `spec/`，再改三端实现，最后补 conformance 用例。若三端不一致，那就是
缺陷。

## 相关项目

- [`store-api`](https://github.com/coenddt/store-api) —— 同一数据层上的 RESTful 皮肤；共享
  同一份 JSON schema 作为唯一事实源。
- [`store-gateway`](../store-gateway) —— 把各协议皮肤组合到一个入口之后（`graphqlPlugin` 是
  宿主与网关的统一入口）。
- 宿主：`nodejs-store`（npm）、`py-store`（PyPI）、`go-store`（Go）——本适配层服务的三个运行
  时绑定。
- 引擎：`rust-store` —— 无 IO 的 Rust core（GQL 解析 / 权限 / 计算列 / 命令规划 / SQL 方言），
  所有皮肤继承其语义。
- 控制面与脚手架：`meta-store`、`create-store-app`、`store-rbac-bootstrap`、
  `store-resource-bootstrap`。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。Copyright (c) 2026 丁滔。
