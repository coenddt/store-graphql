# conformance — 三端一致性用例

同一份场景 JSON（`cases/*.json`），node / py / go 三端各自的 smoke 测试加载执行，断言 GraphQL 行为逐项一致。语义变更必须先改 `spec/`，再三端实现，最后补这里的用例——三者不一致即为缺陷。

## 用例文件格式

```json
{
  "name": "users-graphql",
  "schema": { "name": "User", "fields": {"_id": {"type": "string"}, "name": {"type": "string"}, "age": {"type": "int"}} },
  "steps": [
    { "op": "mutation", "query": "mutation($input: JSON!){ create_User(input: $input){ _id name age } }", "variables": {"input": {"name": "a", "age": 1}}, "expect": {"dataKeys": ["create_User"]} }
  ]
}
```

`expect` 支持键：`dataKeys`（data 中必须出现的键）、`gql`（投影下推后应生成的 GQL 串，末步对齐，用于锁定 spec/02 映射）、`paramsLimit`（params.l 期望值，锁定 limit 守卫缺省语义）、`errorCodePrefix`（errors 首条 message 的稳定前缀，锁定守卫错误契约）。JSON 一律经 variables 传入（spec/01：JSON 标量不接受内联字面量，三端一致）。

## 现状

- v0：用例文件定格式并落第一份 `cases/users-graphql.json`；三端 smoke（`node/test/smoke.test.js`、`py/tests/test_smoke.py`、`go/adapter_test.go`）的用例矩阵与本目录语义对齐（mock store，不连真实库、不依赖 FFI）。
- 待实现（v1）：三端 runner 直接消费 `cases/*.json` 执行并互验；CI 中三端比对。

## 用例清单

- `users-graphql.json`：CRUD 全链路 + 投影下推断言 + limit 守卫（缺省 50 / 超限 `ERR_LIMIT:`）+ 注记（hidden/readonly）+ override/extend
