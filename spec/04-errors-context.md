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

## 请求体上限

三端统一 **1MB**（对齐 store-api 先例 `store-api/go/adapter.go` 的 `io.LimitReader(r.Body, 1<<20)`）：go `LimitReader` 截断后解码失败 ⇒ 400；py 超 ⇒ 413；node 经 Yoga `maxRequestBodySize: 1MB`（Yoga 默认 25MB，显式收窄；出处 `graphql-yoga/esm/server.js:171`）⇒ 413 `REQUEST_ENTITY_TOO_LARGE`。

## 安全模型（v0 边界，如实声明）

| 攻击面 | v0 状态 | 责任边界 |
|---|---|---|
| GQL 串注入 | 通过：全部用户输入（id/condition/sort/limit/input/set）经 params 值通道，零拼接进 GQL 串；投影字段名经 schema 校验方进入 resolver | core 条件编译已核实：IR 层即「参数化 SQL + 按序绑定参数」的结构性约束（`core/src/dialect/ir.rs:5-10`）；唯一例外是显式原生 SQL 通道 `raw.rs`（契约明示的设计边界） |
| 上下文跨请求泄漏 | 通过：py ContextVar（`permission.py:24`）、node AsyncLocalStorage（`permission.js:16`）、go 显式 actx 参数 | — |
| **权限上下文缺失（fail-open）** | **core 信任模型：`ctx: None` = 跳过权限检查，默认放行**（`core/src/permission.rs:9-20` 明文契约）。适配层不配 ContextProvider ⇒ 端点匿名可读写全库 | 生产部署必做两件事：① 配置 ContextProvider（每请求产出身份，返回 None 也显式落地）；② 开启 fail-secure 开关 `store.setRequireContext(true)`（node `index.js:247` / py `__init__.py:242`；rust host `set_require_context`，`host/src/lib.rs:143`）——开启后 ctx 缺失在 plan 入口显式报错，与 `Context::system()` 的内部调用语义彻底分离 |
| 上下文错误分类 | PermissionError（core `ERR_PERMISSION:` 稳定前缀）⇒ 403；其余 ⇒ 401；禁按文案匹配 | — |
| 异步取消 / 中断 | 已核实安全：query 的 two-phase 为纯读；remove 多段写（归档+删除）在同一事务内，失败显式 rollback（`host/src/exec.rs:35-67`，「禁已删未归档静默失守」）；future 被 drop 时 sqlx 未提交事务自动回滚 | 仅 Rust host 直连路径受益此结构性保证；node/py/go 经各自驱动 |
| 查询深度/复杂度攻击 | **未设限（v1）**：深层关系子查询可放大后端负载；部署侧先以反代限流/超时兜底 | v1 接 depth/cost 限制（node 可用 plugin-query-depth，py/go 手写 AST 深度计算） |
| 错误信息泄露（CWE-209） | spec 决策：message 原样透传（内网工具定位；自动反馈原则优先） | 对外部署在网关层做错误映射 |
| Introspection 泄露 | 设计决策：开启（文档/codegen 依赖） | 对外部署在网关层按环境拦截 |
| 批量查询（batching） | 关闭：三端单请求单文档 | — |
| CSRF | GET 无副作用（仅文档页）；POST JSON 非简单请求，跨站被 CORS 预检拦截 | — |
| 请求体大小 | 1MB 上限（本节） | — |
