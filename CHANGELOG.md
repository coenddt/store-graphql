# Changelog

## Unreleased

### Fixed

- **py 执行期权限错误与 node 对齐**：解析器抛出的权限类错误（`PermissionError` 类型 / `ERR_PERMISSION:` /
  同档 `ERR_NO_CONTEXT:` / `no_context`）由 HTTP 200 改为 **403 + `extensions.code = "FORBIDDEN"`**，
  message 原样保留前缀；其余执行错误仍为 200。
- **`extensions.code` 规则统一**：请求级守卫的 `extensions.code` 由 `ERR_DEPTH` / `ERR_COMPLEXITY` /
  `ERR_INTROSPECTION` 改为 `DEPTH` / `COMPLEXITY` / `INTROSPECTION`（与业务错误一致：稳定前缀去 `ERR_`），
  message 仍保留 `ERR_` 前缀。node / py / go 同步。
- **go 补 `__` 保留名过滤**：`Build` 此前无过滤，`__workflowRun` 等 core 控制面内建模型会被
  `graphql.NewObject` 注册进公开类型空间（graphql-go v0.8.1 只校验名字正则，不校验 `__` 前缀）。
  现按 spec/01 与 node / py 同语义：`__` 前缀模型静默跳过注册（不报错），显式 `Options.Resources`
  同样过滤；过滤顺序为归档过滤 → 保留名过滤。
- **显式 `resources` 未套归档过滤（行为修正，非新特性）**：node / py 原实现为
  `filterReserved(resources || filterArchived(store.list()))`，显式传入 `resources` 时**跳过**归档过滤，
  与 spec/01「显式指定时仍套用同一过滤」及 go 实现不符。现统一为
  `filterReserved(filterArchived(resources ?? store.list()))`，三端一致：显式点名归档表
  （如 `UserDeleted`）不再生成类型与字段。此为对既有契约（spec/01）的兑现修正，
  不新增开关、不引入新特性。

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
