# 04 — 错误与上下文

## 错误通道

- store 抛错 ⇒ 进入 GraphQL 标准 `errors` 数组，**原样透传 message，不吞不改写不跨语义兜底**（对齐 no-error-masking：允许被拦截，禁止静默失守）
- data 与 errors 并存是 GraphQL 原生语义：列表部分失败由执行器按字段置 null + 记 error，适配层不做额外包裹
- 成功响应不得出现错误文案；resolver 返回值即 `data`，不做「成功/失败」二次包装

| 端 | 通道 |
|---|---|
| node | resolver 抛错 → Yoga 原生格式化为 GraphQL errors |
| py | `graphql()` 结果的 `result.errors`（`GraphQLError.formatted`） |
| go | `graphql.Do` 结果的 `result.Errors` |

## 上下文（对齐 store-api spec/04 的模式）

`ContextProvider` 钩子：HTTP request → store 用户上下文；三端注入方式：

| 端 | 钩子 | 注入 |
|---|---|---|
| node | `opts.contextFactory(initialCtx)` | `store.setContext(ctx)`（出处 `nodejs-store/src/index.js:287`） |
| py | `context_provider(request)`（支持 async） | 中间件 `store.set_context(ctx)`（出处 `store-api-py/app.py:80`） |
| go | `opts.ContextProvider(req)` | `context.WithValue` 携带 `*gostore.Context` → resolver 经 `p.Context` 取用 |

- Provider 返回 `nil` / `None` **同样显式注入**——清除语义必须落地，禁止身份跨请求残留
- Provider 抛权限类错误 ⇒ 403；其余 ⇒ 401，message 原样透传（REST 口径沿用；GraphQL over HTTP 层按状态码，业务内错误仍在 errors 数组）

## GraphQL over HTTP

- POST `application/json`：`{ query, variables, operationName }` ⇒ `application/json` 响应
- GET：返回 GraphiQL 文档页（spec/05）；GET 查询执行（`?query=&variables=`）列 v1
- Introspection：执行器原生能力，不关闭（SDL / GraphiQL / 客户端 codegen 依赖它）
