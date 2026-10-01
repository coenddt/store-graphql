# 01 — Schema 自动生成（JSON schema → SDL）

## 生成源

- node / py：启动时反射 `store.list()`（归档表过滤后）逐个 `store.get(name)` 取 defn
- go：`Options.Schemas` 显式传入 defn 列表（go-store 的 `Register(defn map[string]any)` 不回读 defn，适配层与注册共用同一份）

## 资源过滤（与 store-api 三端逐字一致）

`XxxDeleted` 且 `Xxx` 也在列表中 ⇒ 归档表，不生成任何类型与字段。`Options/Resources` 显式指定时仍套用同一过滤。

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

- `_id` ⇒ `ID!`（非空）；其余字段一律可空（写入缺省 / 权限裁剪都可能产生 null，不做无依据的非空承诺）
- `computes.*` 视同字段进入类型（type 同上映射；出处：course-platform defn 中 computes 携带自身 `type`）

## 自定义标量 `JSON`

- 语义：任意 JSON 值（承接 condition / sort / input 等动态结构——Hasura 同款务实做法）
- `parseLiteral` 直接报错：**JSON 只接受 variables 传入**（内联字面量解析不实现，三端一致；node 的 graphql-js / py 的 graphql-core 在 parseLiteral 抛错，go 的 graphql-go ParseLiteral 返回 nil 由非空校验拦截）

## 生成面（每模型 X）

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

- 参数三键 `$condition / $sort / $limit` 与现有 GQL 口径一致（出处：`py-store/llms.txt` 用例 `Model($condition:@c0,$sort:@s1,$limit:@l)`；`nodejs-store/src/index.js` 用法注释）
- **待核实（v1）**：偏移分页（`$skip`/`$page`）在 core 的真实参数名；核实前 `list_X` 不提供 offset 参数（宁缺毋滥，不发明语义）
- **待核实（v1）**：`count_X` 走 `QueryWithCount`（go 已有，`go-store/store.go:200`）需要 node/py 对应口径；核实前不生成

## 模型级注记（声明式自定义，spec/03 的第 1 钩子）

defn 顶层可选键 `x-graphql`：

| 注记 | 效果 |
|---|---|
| `"x-graphql": {"hidden": true}` | 该模型不生成任何类型与字段 |
| `"x-graphql": {"readonly": true}` | 只生成 Query 面，不生成 Mutation 面 |

## SDL 导出

- node：`exportSDL(schema)` → `printSchema`；py：`export_sdl(schema)` → `print_schema`
- go：v0 不提供离线导出，SDL 以**标准 introspection** 为准（端点自带）；v1 评估 introspection→SDL 打印器
