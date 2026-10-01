# 03 — 自定义（生成之后的定制路径）

自动生成不是牢笼。四个粒度的自定义钩子，全部是适配层的**正式 API**，按侵入度从低到高排列：

## 钩子 1：注记（声明式，改 schema 不改代码）

defn 上的 `x-graphql` 键（规则见 spec/01）：

```json
{ "name": "SecretLog", "x-graphql": { "hidden": true },   "fields": { ... } }
{ "name": "AuditEvent", "x-graphql": { "readonly": true }, "fields": { ... } }
```

- `hidden`：整个模型不进 SDL（内部表 / 敏感表）
- `readonly`：只出 Query 面（审计 / 日志类，禁止 GraphQL 写入；store RBAC 依旧独立生效，注记只是收窄 GraphQL 面）
- 字段级注记 v0 不做（input 是 JSON 标量，SDL 上无处表达；写入裁剪归 store RBAC——`fields.role.read:["admin"]` 已在 core 拦截，适配层不重复发明）

## 钩子 2：override（换行为，不动 SDL）

按字段路径替换生成 resolver，SDL 保持生成面不变：

```js
// node
buildGraphQLSchema(store, {
  overrides: {
    'Query.list_User': async (src, args, ctx, info) => myCustomList(args, info),
  },
})
```

```python
# py
build_graphql_schema(store, overrides={
    "Query.list_User": my_custom_list,
})
```

```go
// go
storegraphql.Build(st, storegraphql.Options{
    Overrides: map[string]graphql.FieldResolveFn{
        "Query.list_User": func(p graphql.ResolveParams) (interface{}, error) { return myCustomList(p) },
    },
})
```

路径命名：`Query.<field>` / `Mutation.<field>`，与生成面命名一一对应；未命中的路径走默认生成 resolver。

## 钩子 3：extend（加字段，SDL 同步追加）

向 `Query` / `Mutation` 追加自定义字段（类型任意，可组合 `JSON` 标量）：

```js
// node：新增跨模型业务字段，内部仍是 store 既有语义
buildGraphQLSchema(store, {
  extensions: {
    Query: {
      courseStats: {
        type: GraphQLJSON,
        resolve: async () => store.query('Course { groupBy($by:@b) { ... } }', { b: {...} }),
      },
    },
  },
})
```

py：`extensions={"Query": {...}}`；go：`Extensions map[string]graphql.Fields`（键 `Query`/`Mutation`）。extend 进来的字段与生成字段平级出现在 SDL 与 introspection 中——客户端工具链无差别对待。

## 钩子 4：逃生舱（schema-first 接管）

`exportSDL(schema)` 落盘 → 手工修改 SDL → 以 schema-first 模式重新装载，生成器产物只是起点：

- node：`makeExecutableSchema`（graphql-tools）或直接把 SDL 喂给任意执行器
- py：Ariadne（SDL-first 的本命框架）
- go：gqlgen（从 SDL 生成 Go 代码，脱离运行时反射路线）

逃生舱使用后，override/extend 钩子不再适用（类型已脱离本适配层生命周期）；store 调用仍走同一条 `store.query`，语义不旁路。

## 约束（防自定义破坏 parity）

- 自定义 resolver 内允许调用 store 的**任何公开语义**（query/insert/update/remove/原生命令），但不允许绕过 RBAC 上下文注入（spec/04）
- override/extend 的键在构建期校验：未知字段路径 / 非法类型名 ⇒ 构建报错，不静默忽略
