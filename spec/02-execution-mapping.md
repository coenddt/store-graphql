# 02 — 执行映射（GraphQL 请求 → store）

核心策略：**投影下推**。根 resolver 把 GraphQL selection 序列化回现有 GQL 投影串，一次 `store.query` 拿整棵数据——无 N+1，且关系子查询 / 聚合 / 计算列 / 权限 / 方言全部走原有 core 链路。子字段 resolver 只做静态取值。

## 查询 → GQL 串

| GraphQL 参数 | GQL 片段 | params 键 | 拼接条件 |
|---|---|---|---|
| `condition` | `$condition:@c0` | `c0` | 非 null 才拼 |
| `sort` | `$sort:@s1` | `s1` | 非 null 才拼 |
| `limit` | `$limit:@l` | `l` | 非 null 才拼 |

- `get_X(id)` ⇒ `X($condition:@c0){<投影>}`，`c0 = {"_id": id}`，取结果首条，空则 `null`
- `list_X(...)` ⇒ 按上表按需拼接参数头 + `{<投影>}`（`limit` 恒拼接，见下节守卫）
- 主键字段名 `id_field` v0 固定 `_id`（与 store-api spec/01 一致；不改参数面）

## limit 守卫（适配层语义，2026-10 性能核实后新增）

- 依据：core 的行数封顶（`clamp_t2q_limit` / `force_t2q_limit`）**仅 text2query 档生效，`standard` 档原样返回**（`core/src/pipeline/util.rs:62-83`）——GraphQL 端走默认档，`limit` 不守卫即全量拉取
- 三端 resolver 守卫：**缺省补 `limit: 50`**（防忘传全表，恒拼接 `$limit:@l`）；**显式 `limit > 1000` ⇒ resolver 抛错**，错误信息带稳定前缀 `ERR_LIMIT:`（对齐 core `ERR_PERMISSION:` 的前缀契约风格，客户端可判定；遵循「允许被拦截、禁止静默失守」，不静默截断）
- `limit ≤ 0` 与非整数：原样传 core，语义归 core（适配层不发明；待核实 v1）
- 数值（缺省 50 / 上限 1000）为适配层常量，调整先改本 spec 再三端同步

## Mutation 语义

| 操作 | store 调用 | 返回 |
|---|---|---|
| `create_X` | `insert(X, input)` | 插入后全文档 |
| `update_X` | `update(X, {"_id": id}, set)` 后按 selection 回读 | 回读文档（不依赖 update 返回值口径，三端一致） |
| `delete_X` | `remove(X, {"_id": id})` | `true`（失败经错误通道，见 04） |

## selection → 投影串（node / py 精确下推）

遍历根 field 的 selectionSet：

1. `FIELD` ⇒ `name` + 嵌套 `{ }`；**输出别名（alias）v0 忽略**（按字段名输出；core 的 GQL 投影无 alias 语义，待核实 v1）
2. `InlineFragment` ⇒ 原地展开其 selectionSet
3. `FragmentSpread` ⇒ 经 `info.fragments` 展开后递归
4. `@skip` / `@include` 指令 ⇒ 序列化时自行求值（`if` 取 `info.variableValues`；自定义序列化不经过执行器指令过滤，必须自己评估）
5. 空投影防御：序列化结果为空 ⇒ 回退 `_id`（GraphQL 规范保证 meta 字段存在时用 `__typename` 兜底不可取——直接回退 `_id`，保证 GQL 串合法）

## go 端 v0 差异（如实标注）

- 投影序列化基于 `ResolveParams.Info.FieldASTs` 直投；**Fragment 展开未实现（v1）**，含 Fragment 的请求按字段直投，缺字段时 Go 端回退全字段投影（注册 defn 的字段键全集）
- JSON 标量 `parseLiteral` 返回 nil（graphql-go 该钩子无 error 通道），配合参数非空校验拦截内联 JSON——语义为「必须走 variables」

## 内省与客户端 SDK（白拿链路）

SDL 导出（01）→ 喂 `@graphql-codegen` / `ariadne-codegen` / genqlient ⇒ 自动生成的 Query/Mutation 文档与类型化客户端。适配层不做客户端代码生成，只保证 SDL 是唯一出口。
