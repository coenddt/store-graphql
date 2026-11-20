# Changelog

## 1.1.1 (2026-11-20, Go module only)

### Fixed

- **Go module path 修正为子目录标准形式**：`github.com/coenddt/store-graphql-go` → `github.com/coenddt/store-graphql/go`。
  原路径指向不存在的 GitHub 仓库，Go proxy 返回 404（`not found: module ...`），`go/v*` tag 实际不可消费；
  npm / PyPI 无新版本（仍为 1.1.0），仅 Go 端以 `go/v1.1.1` 发布。

## 1.1.0 (2026-11-20)

> 向后兼容扩展：只新增根字段与类型，`listX` 的入参、返回结构与错误契约一律不变。

### Added

- **分页根字段 `pageX`**（三端同步）：`pageX(condition: JSON, sort: JSON, page: Int, pageSize: Int): XPage!`，
  `XPage { items: [X!]!, total: Int!, hasMore: Boolean!, page: Int!, pageSize: Int! }`。
  直接走宿主 `queryWithCount`（node `store.queryWithCount` / py `store.query_with_count` / go `QueryWithCount`），
  不碰 rust core，也不重算 count。
- **分页语义**（spec/01、02）：`page` 缺省 0、`pageSize` 缺省 50（上限 5000）、深翻页 `page*pageSize ≤ 100000`；
  越界 / `$near` 并用 / 宿主缺能力分别显式报 `ERR_LIMIT:` / `ERR_CAPABILITY:`，不静默截断或降级。
- **conformance 契约扩展**：`expect` 新增 `pageField` / `total` / `hasMore` / `page` / `pageSize` /
  `itemsLength` / `paramsPage` / `paramsPageSize`；用例覆盖缺省 pageSize、total、hasMore 边界、
  pageSize 上限、深翻页上限、page 负数与 `$near` 互斥。

### Build

- `go/go.mod` 间接依赖对齐本地 `go-store`（`modernc.org/sqlite` 1.62.0 等），保证 `go test ./...` 可运行。

### 未改动

- `listX` 的 `limit` 守卫（缺省 50 / 上限 1000）与 `$near` 互斥规则保持原样。
- 独立 `countX` 不生成（计数由 `pageX.total` 覆盖）。

## 1.0.0 (2026-11-08)

> 目标版本 **1.0.0**（未发布；版本号由发布流程统一 bump）。本轮采用「旧值原地不动 + 新增规范化字段」的
> 兼容策略，破坏性变更只保留两条，均已单列在 `Breaking` 下。

### Breaking

#### 1. 显式 `resources` 也套归档过滤（默认过滤）

- **改了什么**：此前显式传入 `options.resources` 时，归档表（`User` 存在时的 `UserDeleted`）会被直接注册进
  类型空间；现统一为 `filterReserved(filterArchived(resources ?? store.list()))`，即**显式点名也默认过滤**。
- **下游要动哪里**：显式传了 `UserDeleted` 之类归档表的调用方，默认将拿到「类型不存在」（查询报错 / 字段缺席）。
  需要保留该能力时打开显式开关：node `storeGraphql(schema, { includeArchived: true })`、
  py `build_graphql_schema(store, schemas, include_archived=True)`、go
  `storegraphql.Options{IncludeArchived: true}`。开关注释见下 `Added`。

#### 2. `__` 前缀模型不进公开类型空间（go 端补齐）

- **改了什么**：go `Build` 此前无保留名过滤，`__workflowRun` 等 core 控制面内建模型会被
  `graphql.NewObject` 注册进公开类型空间（graphql-go v0.8.1 只校验名字正则，不校验 `__` 前缀）；现与
  node / py 同语义：`__` 前缀模型静默跳过注册（不报错），显式 `Options.Resources` 同样过滤。
  过滤顺序固定为「归档过滤 → 保留名过滤」。
- **下游要动哪里**：此前在 go 端能查询 `__` 前缀模型的调用方，该类型不再存在，查询会返回 schema 校验错误。
  这类模型属 core 控制面，不应作为业务类型暴露，故不提供开关。

### Added

- **`includeArchived` 开关**（非破坏，默认关闭）：仅当显式开启时跳过归档过滤，点名要看归档表的调用方可拿到；
  `__` 保留名过滤不受该开关影响。三语言写法：

  ```javascript
  // node
  const schema = storeGraphql(store, { schemas, includeArchived: true });
  ```

  ```python
  # py
  schema = build_graphql_schema(store, schemas, include_archived=True)
  ```

  ```go
  // go
  schema, err := storegraphql.Build(store, storegraphql.Options{
      Schemas:         schemas,
      IncludeArchived: true,
  })
  ```

- **`extensions.normalizedCode`**（非破坏，三端）：请求级守卫的 `extensions.code` 保留旧值
  `ERR_DEPTH` / `ERR_COMPLEXITY` / `ERR_INTROSPECTION`，另置规范化值 `DEPTH` / `COMPLEXITY` /
  `INTROSPECTION`。按旧值精确匹配的客户端不受影响；新客户端可只读 `normalizedCode`。
- **go 执行期 `extensions.code`**（非破坏）：此前 go `Handler` 在 `graphql.Do` 后直接编码结果，执行期错误没有
  `extensions.code`；现与 node / py 同规则，从错误 message 的 `ERR_<CODE>:` 前缀推导并注入（只增字段，
  不删旧行为）。

### Fixed

- **执行期权限错误三端统一 200 + `extensions.code = "FORBIDDEN"`**：解析器抛出的权限类错误
  （`PermissionError` 类型 / `ERR_PERMISSION:` / 同档 `ERR_NO_CONTEXT:` / `no_context`）不再按状态码分叉
  （node 由 403 回调 200，py / go 维持 200）。依据 GraphQL over HTTP：执行期错误本就 200，靠
  `extensions.code` 区分；message 原样保留前缀。`contextProvider` / `policyProvider` 预执行层失败
  仍走既有 403/401，请求体超限仍 413 —— 这两层是**传输层拒绝**，与执行期错误分层处理。
- **守卫 `extensions.code` 保留旧值**：见 `Added` 中的 `normalizedCode`；message 仍保留 `ERR_` 前缀。

## 0.6.0 (2026-11-02)

### Breaking（修复：根字段命名 `动作前缀_模型名` → 纯驼峰）

- **生成的 Query/Mutation 根字段名全变**：删除拼接串里的 `_`，改为动词 camelCase +
  模型名 PascalCase 直接拼接。修复定性为 bug 而非风格偏好：GraphQL 全生态唯一通行
  惯例是类型名 PascalCase、字段名 camelCase（graphql-codegen / Apollo 等前端工具链
  按 camelCase 假设生成 TS 类型与方法名），旧形态迫使消费方用别名包装。
  当前无生产消费方，零迁移成本。
- 新旧名对照（`X` 为模型名，如 `User` → `listUser`）：

  | 旧名 | 新名 |
  |---|---|
  | `get_X` | `getX` |
  | `list_X` | `listX` |
  | `create_X` | `createX` |
  | `update_X` | `updateX` |
  | `delete_X` | `deleteX` |

- 同步改动面：spec/00–05 生成面描述、`conformance/cases/*.json` 语句与 `dataKeys`
  断言、三端实现（py `adapter.py` / node `src/index.js` / go `adapter.go` 的字段注册
  与 override 路径 `Query.getX` / `Mutation.createX` 键）、三端全部测试。
- 不变项：store 层 GQL tree 语法（`Model($condition:@c0)`）、`x-graphql` 注记键
  （hidden/readonly）、`ERR_*` 错误前缀体系、`__schema`/`__typename` 内省行为、
  override/extend 校验逻辑。
- 不留命名配置开关：单一终态，不搞两套。

## 0.5.1

- 版本维护（发布元数据）。

## 0.5.0

- `_score` 字段与 `$near` limit 守卫（spec/01、04；三端同步，exec 04）。
- README 扩写为完整使用文档（三端快速上手 / 错误矩阵 / 部署矩阵）。
