# DEPLOYMENT — 生产部署清单

store-graphql 适配层的语义安全(注入面/上下文隔离/守卫)由仓库保证;**部署安全由本清单负责**。逐项打勾后再对外。

## 1. 权限上下文(最高优先级)

core 的信任模型是 **fail-open**:`ctx: None` = 跳过权限检查(`core/src/permission.rs:9-20` 明文契约)。适配层不配上下文 ⇒ 端点匿名可读写全库。生产必做两件事:

| 项 | node | py | go |
|---|---|---|---|
| 每请求上下文钩子 | `createYoga(store, { contextFactory: async ({ request }) => ... })`(返回 `null` 也显式落地清除) | `create_app(store, context_provider=request)`(支持 async) | `Handler(schema, Options{ContextProvider: func(r) (*gostore.Context, error)})` |
| fail-secure 开关 | `store.setRequireContext(true)`(`nodejs-store/src/index.js:247`) | `store.set_require_context(True)`(`py-store/src/py_store/__init__.py:242`) | rust host `store.set_require_context(true)`(`host/src/lib.rs:143`;go-store 经 FFI 同语义) |

开启 fail-secure 后,ctx 缺失在 plan 入口显式报错;系统内部调用(索引创建、归档回填)用 `Context::system()` 语义显式表达,与"忘传"彻底分离。

## 2. HTTP 请求头 → Context 映射参考

以「签名 token → userId/roles」为例(contextFactory 内完成,适配层不发明认证):

```js
// node
contextFactory: async ({ request }) => {
  const token = request.headers.get('authorization');
  const user = token ? await verifyToken(token) : null;   // 校验失败可抛 ERR_PERMISSION: 前缀错误 ⇒ 403
  return user ? { userId: user.id, roles: user.roles } : null;
}
```

## 3. 内建守卫核对(适配层自带,无需部署配置)

| 守卫 | 默认 | 超限行为 | 覆盖参数 |
|---|---|---|---|
| 请求体上限 | 1MB | 413 / 400 | node `maxRequestBodySize`(Yoga);go `maxBodyBytes` 常量;py 常量 |
| limit 守卫 | 缺省 50 / 上限 1000 | `ERR_LIMIT:` 抛错 | spec/02 常量 |
| 查询深度 | 10 | 400 `ERR_DEPTH:` | `maxQueryDepth` / `max_query_depth` / `MaxQueryDepth`(0=默认) |
| 查询复杂度 | 字段数 300 | 400 `ERR_COMPLEXITY:` | `maxQueryFields` / `max_query_fields` / `MaxQueryFields`(0=默认) |
| introspection | 开启 | 关闭时 400 `ERR_INTROSPECTION:` | `introspection: false` / `DisableIntrospection: true` |

对外暴露建议:`introspection: false`(SDL/codegen 在内网完成后再上线)。

## 4. 网关层(nginx 参考配置)

适配层不做连接级防护,叠加在反代:

```nginx
server {
  location /graphql {
    # 连接级限流(每 IP 10 r/s,突发 20)
    limit_req zone=graphql burst=20 nodelay;
    # 慢查询掐断(配合适配层守卫,防长查询占连接)
    proxy_read_timeout 10s;
    proxy_pass http://127.0.0.1:4000;
  }
}
# http 块内:limit_req_zone $binary_remote_addr zone=graphql:10m rate=10r/s;
# TLS 终止在网关(适配层只出 HTTP);CORS 由网关按域白名单配置
```

## 5. 错误前缀告警表(自动反馈接线)

守卫触发即上游异常征兆,按 no-error-masking 的自动反馈原则接入告警:

| 前缀 | 含义 | 告警动作 |
|---|---|---|
| `ERR_PERMISSION:` | RBAC 拒绝(core) | 高频 = 越权探测,聚合 source IP |
| `ERR_LIMIT:` | limit 超上限 | 高频 = 客户端分页实现错误 |
| `ERR_DEPTH:` | 查询深度超限 | 出现即攻击尝试,告警 |
| `ERR_COMPLEXITY:` | 字段数超限 | 出现即攻击尝试,告警 |
| `ERR_INTROSPECTION:` | 禁用后探测 schema | 出现即侦察行为,告警 |
| 401 `CONTEXT_ERROR` | 上下文钩子故障 | **立即告警**(鉴权链路坏了,而非用户错) |

## 6. 上线前核对清单

- [ ] ContextProvider 已配且经压测(并发下身份隔离:py ContextVar / node ALS / go 显式参数)
- [ ] `setRequireContext(true)` 已开
- [ ] `introspection: false`(对外)或网关按环境拦截
- [ ] 反代限流 + 超时 + TLS 已配(§4)
- [ ] 错误前缀告警接线(§5)
- [ ] SDL 已导出归档(`exportSDL()`,禁 introspection 后客户端 codegen 用它)
- [ ] 三端 smoke 全绿且与 `spec/`、`conformance/` 三者一致
