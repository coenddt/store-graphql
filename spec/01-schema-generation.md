# 01 — Schema 自动生成（JSON schema → SDL）

## 生成源

- node / py：启动时反射 `store.list()`（归档表过滤后）逐个 `store.get(name)` 取 defn
- go：`Options.Schemas` 显式传入 defn 列表（go-store 的 `Register(defn map[string]any)` 不回读 defn，适配层与注册共用同一份）

## 资源过滤（与 store-api 三端逐字一致）

`XxxDeleted` 且 `Xxx` 也在列表中 ⇒ 归档表，不生成任何类型与字段。`Options/Resources` 显式指定时默认仍套用同一过滤。

- **显式开关**：`includeArchived`（node `includeArchived` / py `include_archived` / go `Options.IncludeArchived`）默认 `false`；置 `true` 时跳过归档过滤，点名要看归档表的下游可拿到（既有默认行为不变）。

## 保留名过滤（GraphQL 皮专有）

GraphQL 规范把 `__` 前缀保留给 introspection，故凡以 `__` 开头的模型名一律**跳过注册**（不报错、不降级为其他类型）——core 控制面内建模型（`__workflowRun`、`__schemaDef`、`__workflowDef`、`__feedback`）因此不会进入公开类型空间。`Options/Resources` 显式指定时套用同一过滤。

- 三端语义一致：node `filterReserved` / py `filter_reserved` / go `filterReserved`（顺序：先归档过滤，再保留名过滤；`includeArchived=true` 时跳过前者）
- 该过滤仅限 GraphQL 皮；REST / gRPC / MCP 不套用（其资源面不生成 GraphQL 类型，`__` 名无冲突）
- 与归档过滤同档：属声明式排除，静默跳过；不视为守卫拦截，故不产生告警事件
- **`__` 过滤不受 `includeArchived` 开关影响**（GraphQL 规范硬约束，无条件生效）

## 类型映射（defn `fields.*.type` → GraphQL 输出类型）

词汇表出处：`py-store/example/course-platform/schema.json` 实测全集 `string / int / float / bool / datetime / object / array`。

| defn type | GraphQL 类型 | 说明 |
|---|---|---|
| `string` / `datetime` | `String` | datetime v0 按 ISO 字符串透传，不出自定 scalar |
| `int` | `Int` | |
| `float` | `Float` | |
| `bool` | `Boolean` | |
| `object`（含 `fields`） | 嵌套 ObjectType，命名 `<父类型>_<字段路径>` | 递归下钻 |
| `object`（无 `fields`）/ `array` / 其他未知 | `JSON`（自定义标量） | 不丢语义的最小承诺 |
| 派生列 | `_score` | `Float`（可空） |

- `_id` ⇒ `ID!`（非空）；其余字段一律可空（写入缺省 / 权限裁剪都可能产生 null，不做无依据的非空承诺）
- `computes.*` 视同字段进入类型（type 同上映射；出处：course-platform defn 中 computes 携带自身 `type`）
- `_score` 由向量检索（`$near`）产出，恒注入每个模型类型，可空；
  非向量查询请求 `_score` 由 core 显式报错（见 04 §4.3）。
- `_score` 为保留名，schema 的 fields / relations / computes 均不得声明。

## 自定义标量 `JSON`

- 语义：任意 JSON 值（承接 condition / sort / input 等动态结构——Hasura 同款务实做法）
- `parseLiteral` 直接报错：**JSON 只接受 variables 传入**（内联字面量解析不实现，三端一致；node 的 graphql-js / py 的 graphql-core 在 parseLiteral 抛错，go 的 graphql-go ParseLiteral 返回 nil 由非空校验拦截）

## 生成面（每模型 X）

```graphql
type X { _id: ID!, ...fields, ...computes }

type Query {
  getX(id: ID!): X
  listX(condition: JSON, sort: JSON, limit: Int): [X!]!
}

type Mutation {
  createX(input: JSON!): X
  updateX(id: ID!, set: JSON!): X
  deleteX(id: ID!): Boolean!
}
```

- 参数三键 `$condition / $sort / $limit` 与现有 GQL 口径一致（出处：`py-store/llms.txt` 用例 `Model($condition:@c0,$sort:@s1,$limit:@l)`；`nodejs-store/src/index.js` 用法注释）
- **待核实（v1）**：偏移分页（`$skip`/`$page`）在 core 的真实参数名；核实前 `listX` 不提供 offset 参数（宁缺毋滥，不发明语义）
- **待核实（v1）**：`countX` 走 `QueryWithCount`（go 已有，`go-store/store.go:200`）需要 node/py 对应口径；核实前不生成

## 模型级注记（声明式自定义，spec/03 的第 1 钩子）

defn 顶层可选键 `x-graphql`：

| 注记 | 效果 |
|---|---|
| `"x-graphql": {"hidden": true}` | 该模型不生成任何类型与字段 |
| `"x-graphql": {"readonly": true}` | 只生成 Query 面，不生成 Mutation 面 |

## SDL 导出

- node：`exportSDL(schema)` → `printSchema`；py：`export_sdl(schema)` → `print_schema`
- go：v0 不提供离线导出，SDL 以**标准 introspection** 为准（端点自带）；v1 评估 introspection→SDL 打印器
