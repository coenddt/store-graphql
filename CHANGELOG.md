# Changelog

## Unreleased

### Fixed

- **执行期权限错误三端统一 200 + `extensions.code = "FORBIDDEN"`**：解析器抛出的权限类错误
  （`PermissionError` 类型 / `ERR_PERMISSION:` / 同档 `ERR_NO_CONTEXT:` / `no_context`）不再按状态码分叉
  （node 由 403 回调 200，py / go 维持 200）。依据 GraphQL over HTTP：执行期错误本就 200，靠
  `extensions.code` 区分；message 原样保留前缀。`contextProvider` / `policyProvider` 预执行层失败
  仍走既有 403/401。
- **守卫 `extensions.code` 保留旧值 + 新增 `normalizedCode`**：请求级守卫的 `extensions.code` 仍为
  `ERR_DEPTH` / `ERR_COMPLEXITY` / `ERR_INTROSPECTION`（不惊动按旧值匹配的调用方），另置
  `extensions.normalizedCode` = `DEPTH` / `COMPLEXITY` / `INTROSPECTION`；message 仍保留 `ERR_` 前缀。
  node / py / go 同步。
- **go 补 `__` 保留名过滤**：`Build` 此前无过滤，`__workflowRun` 等 core 控制面内建模型会被
  `graphql.NewObject` 注册进公开类型空间（graphql-go v0.8.1 只校验名字正则，不校验 `__` 前缀）。
  现按 spec/01 与 node / py 同语义：`__` 前缀模型静默跳过注册（不报错），显式 `Options.Resources`
  同样过滤；过滤顺序为归档过滤 → 保留名过滤。
- **显式 `resources` 归档过滤：默认仍过滤 + 新增 `includeArchived` 开关**：node / py / go 统一为
  默认 `filterReserved(filterArchived(resources ?? store.list()))`（既有默认行为不变）；仅当
  `includeArchived: true`（py `include_archived=True` / go `Options.IncludeArchived=true`）时跳过归档过滤，
  点名要看归档表的调用方可拿到。`__` 保留名过滤不受该开关影响。

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
