# Changelog

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
