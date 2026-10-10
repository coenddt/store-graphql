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
| node | `opts.contextFactory({ request, serverContext })` | `store.setContext(ctx)`（出处 `nodejs-store/src/index.js:306`） |
| py | `context_provider(request)`（支持 async） | 中间件 `store.set_context(ctx)`（出处 `store-api-py/app.py:80`） |
| go | `opts.ContextProvider(req)` | `context.WithValue` 携带 `*gostore.Context` → resolver 经 `p.Context` 取用 |

- Provider 返回 `nil` / `None` **同样显式注入**——清除语义必须落地，禁止身份跨请求残留
- Provider 抛权限类错误 ⇒ 403；其余 ⇒ 401，message 原样透传（REST 口径沿用；GraphQL over HTTP 层按状态码，业务内错误仍在 errors 数组）

## GraphQL over HTTP

- POST `application/json`：`{ query, variables, operationName }` ⇒ `application/json` 响应
- GET：返回 GraphiQL 文档页（spec/05）；GET 查询执行（`?query=&variables=`）列 v1
- Introspection：执行器原生能力，不关闭（SDL / GraphiQL / 客户端 codegen 依赖它）

## 错误呈现（node：Yoga 掩码默认）

- **默认原样透出 message**（与 py / go 一致，符合本 spec 首节「原样透传，不吞不改写」）——node 经 Yoga `maskedErrors.maskError` 实现；py/go 执行器本就原样透出，故本项为三端 parity
- **权限类错误**（core 稳定前缀 `ERR_PERMISSION:`，或权限类同档的 `NoContext`：主机 `NoContextError` machine code `no_context` / core 前缀 `ERR_NO_CONTEXT:`）⇒ HTTP **403** + `extensions.code = 'FORBIDDEN'`；message **原样保留前缀**（前缀剥离属展示层选择，禁写死进适配层）
- 覆盖口子：`maskError` 单独覆盖掩码函数；`maskedErrors` 直通 Yoga（对外部署可传 Yoga 默认掩码或自定策略，见 [DEPLOYMENT.md](../DEPLOYMENT.md)）

## HTTP 承载封装

| 端 | 封装 | 缺省端点 | 说明 |
|---|---|---|---|
| node | `graphqlPlugin(fastify, { store, path, ...createYoga opts })` | `/graphql` | Fastify 插件；宿主与 store-gateway 的统一入口 |
| node | `createYoga(store, opts)` → `{ yoga, schema }` | Yoga 自身缺省 | fetch handler，供非 Fastify 框架或独立跑 |
| py | `create_app(store, **opts)` | `/graphql` | FastAPI 应用（可选依赖） |
| go | `Handler(schema, opts)` | `opts.Path` | 标准库 `net/http` |

- 桥接契约（node）：每请求构造 Web `Request` → 调用 `yoga` → 回拷 status / headers / body 到 Fastify reply
- **响应头回拷必须剔除** `content-length` / `content-encoding` / `transfer-encoding`——body 经 `res.text()` 已解码，回拷原值会与实际字节不符；`set-cookie` 须经 `getSetCookie()` 逐条 append（iterator 给的是合并串）

## 请求体上限

三端统一 **1MB**（对齐 store-api 先例 `store-api/go/adapter.go` 的 `io.LimitReader(r.Body, 1<<20)`）：go `LimitReader` 截断后解码失败 ⇒ 400；py 超 ⇒ 413；node 经 Yoga `maxRequestBodySize: 1MB`（Yoga 默认 25MB，显式收窄；出处 `graphql-yoga/esm/server.js:171`）⇒ 413 `REQUEST_ENTITY_TOO_LARGE`。

## 安全模型（v0 边界，如实声明）

| 攻击面 | v0 状态 | 责任边界 |
|---|---|---|
| GQL 串注入 | 通过：全部用户输入（id/condition/sort/limit/input/set）经 params 值通道，零拼接进 GQL 串；投影字段名经 schema 校验方进入 resolver | core 条件编译已核实：IR 层即「参数化 SQL + 按序绑定参数」的结构性约束（`core/src/dialect/ir.rs:5-10`）；唯一例外是显式原生 SQL 通道 `raw.rs`（契约明示的设计边界） |
| 上下文跨请求泄漏 | 通过：py ContextVar（`permission.py:24`）、node AsyncLocalStorage（`permission.js:16`）、go 显式 actx 参数 | — |
| **权限上下文缺失（fail-open）** | **core 信任模型：`ctx: None` = 跳过权限检查，默认放行**（`core/src/permission.rs:9-20` 明文契约）。适配层不配 ContextProvider ⇒ 端点匿名可读写全库 | 生产部署必做两件事：① 配置 ContextProvider（每请求产出身份，返回 None 也显式落地）；② 开启 fail-secure 开关 `store.setRequireContext(true)`（node `index.js:247` / py `__init__.py:242`；rust host `set_require_context`，`host/src/lib.rs:143`）——开启后 ctx 缺失在 plan 入口显式报错，与 `Context::system()` 的内部调用语义彻底分离 |
| 上下文错误分类 | PermissionError（core `ERR_PERMISSION:` 稳定前缀）⇒ 403；NoContext（machine code `no_context` / `ERR_NO_CONTEXT:`，权限类同档）⇒ 403；其余 ⇒ 401；禁按文案匹配 | — |
| 异步取消 / 中断 | 已核实安全：query 的 two-phase 为纯读；remove 多段写（归档+删除）在同一事务内，失败显式 rollback（`host/src/exec.rs:35-67`，「禁已删未归档静默失守」）；future 被 drop 时 sqlx 未提交事务自动回滚 | 仅 Rust host 直连路径受益此结构性保证；node/py/go 经各自驱动 |
## 查询深度守卫（2026-10 v1 落地）

- 算法三端同构：**深度 = 从 operation 顶层 selectionSet 起的最大字段嵌套层数**（顶层字段为第 1 层；`InlineFragment` 原地展开；`FragmentSpread` 按 document 的 fragment 定义递归，已访问集合防环）；取所有 operation 的最大值
- 上限 **`MAX_QUERY_DEPTH = 10`**（合法业务嵌套 2~4 层：模型→关系→关系，余量充足；常量可调，先改本 spec 再三端同步）
- 超限 ⇒ **HTTP 400**，errors 首条 message 带稳定前缀 **`ERR_DEPTH:`**（请求级校验失败，区别于执行期错误的 200 + errors；node 经 Yoga 插件 `onExecute` 抛 `GraphQLError` + `extensions.http.status`，py/go 在执行前独立 parse 检查）
- 语法错误不在此拦截（维持执行器原路径 200 + errors），双 parse 成本微秒级（py/go），如实标注

| 攻击面 | v0 状态 | 责任边界 |
|---|---|---|
| 查询深度攻击 | **已设限**（本节：深度 10，超限 400 + `ERR_DEPTH:`） | 部署侧反代限流仍建议叠加 |
| 查询复杂度（字段数） | **已设限**：`MAX_QUERY_FIELDS = 300`（AST 字段节点总数，fragment 展开计入、防环；超限 400 + `ERR_COMPLEXITY:`）。**别名不单列**——别名是字段的属性，字段计数已覆盖别名堆叠 | 基于权重的 cost 分析列 v2；`maxQueryFields` 可覆盖（0 = 默认） |
| Introspection 泄露 | **可配置**：默认开启（文档/codegen 依赖）；`introspection: false` 时含 `__schema`/`__type` 字段的请求 ⇒ 400 + `ERR_INTROSPECTION:`（`__typename` 放行，无泄露面） | 对外部署建议关闭 + 网关层兜底；开关与网关双保险见 [DEPLOYMENT.md](../DEPLOYMENT.md) |
| 错误信息泄露（CWE-209） | spec 决策：message 原样透传（内网工具定位；自动反馈原则优先） | 对外部署在网关层做错误映射；错误前缀告警表见 [DEPLOYMENT.md](../DEPLOYMENT.md) |
| 批量查询（batching） | 关闭：三端单请求单文档 | — |
| CSRF | GET 无副作用（仅文档页）；POST JSON 非简单请求，跨站被 CORS 预检拦截 | — |
| 请求体大小 | 1MB 上限（本节） | — |
