'use strict';

/**
 * spec/04 GraphQL Yoga 承载（D4-4 零语义拆分自 index.js）。
 *
 * fail-secure 装配守卫、policyProvider 作用域包装、深度 / 复杂度守卫插件、
 * 每请求上下文注入与掩码解析。HTTP 插件入口见 ./http.js。
 */

const { GraphQLError } = require('graphql');

const { MAX_QUERY_DEPTH, MAX_QUERY_FIELDS, queryDepthOf, queryFieldCount } = require('./guards');
const { buildGraphQLSchema } = require('./schema');
const { defaultMaskError, classifiedErrorResponse } = require('./error-mask');

/**
 * fail-secure 装配守卫：宿主开启上下文强制却未配 contextFactory 时，装配期即拒绝
 * （fail-fast）；否则每请求在运行期以 ERR_NO_CONTEXT 失败（no-error-masking）。
 */
function assertSecureConfig(store, opts) {
  if (typeof store.requireContext === 'function' && store.requireContext() && !opts.contextFactory) {
    throw new Error(
      'ERR_SECURE_CONFIG: 宿主已开启上下文强制（fail-secure）但未配置 opts.contextFactory；'
      + '请注入从请求解析身份的 contextFactory（spec/04），'
      + '无需鉴权的内部服务请显式 store.setRequireContext(false) 后再装配',
    );
  }
}

// R2-04：policyProvider 可选注入（进程级全局单值状态，默认关闭 = 现状零变化）。
// 视图派生只许 store.baseView().withPolicy(overrides)（皮侧禁自持 Registry——R2-04 §7），
// 作用域原语 withScope 为 nodejs-store optional peer，仅注入 policyProvider 时才加载。
/** 取 store 的作用域包装（policyProvider 存在时每请求包 withScope；缺 baseView 即报错） */
function resolveWithScope(store) {
  if (typeof store.baseView !== 'function') {
    throw new Error(
      'ERR_POLICY_PROVIDER_CONFIG: 注入 policyProvider 需要宿主 store.baseView()'
      + '（nodejs-store 提供）；皮侧禁自持 Registry 派生视图（R2-04 §7）',
    );
  }
  try {
    return require('nodejs-store').withScope;
  } catch (e) {
    throw new Error(`ERR_DEPENDENCY_MISSING: 注入 policyProvider 需要安装 nodejs-store（withScope）: ${(e && e.message) || e}`);
  }
}

/** 加载 graphql-yoga（可选依赖） */
function loadYoga() {
  try {
    return require('graphql-yoga');
  } catch {
    throw new Error('使用 createYoga 需要安装 graphql-yoga（npm i graphql-yoga）；或仅用 buildGraphQLSchema 自行承载');
  }
}

/** 深度守卫：超限以 ERR_DEPTH 拦截（http 400） */
function assertDepth(document, depthLimit) {
  const d = queryDepthOf(document);
  if (d > depthLimit) {
    throw new GraphQLError(`ERR_DEPTH:查询深度 ${d} 超过上限 ${depthLimit}`, {
      extensions: { code: 'ERR_DEPTH', normalizedCode: 'DEPTH', http: { status: 400 } },
    });
  }
}

/** 复杂度 / introspection 守卫：超限或禁用期使用 introspection 均以 http 400 拦截 */
function assertFieldBudget(document, fieldsLimit, introspectionEnabled) {
  const { fields, introspectionUsed } = queryFieldCount(document);
  if (introspectionUsed && !introspectionEnabled) {
    throw new GraphQLError('ERR_INTROSPECTION:introspection 已禁用', {
      extensions: { code: 'ERR_INTROSPECTION', normalizedCode: 'INTROSPECTION', http: { status: 400 } },
    });
  }
  if (fields > fieldsLimit) {
    throw new GraphQLError(`ERR_COMPLEXITY:查询字段数 ${fields} 超过上限 ${fieldsLimit}`, {
      extensions: { code: 'ERR_COMPLEXITY', normalizedCode: 'COMPLEXITY', http: { status: 400 } },
    });
  }
}

/** spec/04:深度/复杂度/introspection 守卫(onExecute 期拦截,extensions.http.status 定 400) */
function guardPlugin(depthLimit, fieldsLimit, introspectionEnabled) {
  return {
    onExecute({ args }) {
      assertDepth(args.document, depthLimit);
      assertFieldBudget(args.document, fieldsLimit, introspectionEnabled);
    },
  };
}

/**
 * 每请求注入上下文：同步 contextFactory 走快路径——不引入 await 微任务，
 * 避免 AsyncLocalStorage.enterWith 在微任务里落地致上下文传不到 resolver
 * （返回 null 同样显式落地清除）。
 */
async function applyContext(store, contextFactory, req, serverCtx) {
  const maybe = contextFactory({ request: req, serverContext: serverCtx });
  const ctx = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
  store.setContext(ctx != null ? ctx : null);
  return ctx;
}

/** 包装层：每请求先跑 contextFactory 并按 spec/04 分类（403/401），再进 Yoga 执行 */
function createHandler(store, yoga, opts, policyProvider, withScopeFn) {
  return async (req, serverCtx) => {
    let ctx = null;
    if (opts.contextFactory) {
      try {
        ctx = await applyContext(store, opts.contextFactory, req, serverCtx);
      } catch (e) {
        return classifiedErrorResponse(e);
      }
    }
    // R2-04：policyProvider 收已解析 ctx（未配 contextFactory ⇒ null，禁二次调用 provider）；
    // 返回非空则派生视图并以 withScope 包裹 Yoga 执行（resolver 经 currentView() 读作用域视图）；
    // policyProvider 异常按 spec/04 同 contextFactory 分类（403/401），禁吞。
    if (policyProvider) {
      try {
        const overrides = policyProvider(ctx != null ? ctx : null);
        const view = overrides ? store.baseView().withPolicy(overrides) : null;
        return withScopeFn(view ? { view } : null, () => yoga(req, serverCtx));
      } catch (e) {
        return classifiedErrorResponse(e);
      }
    }
    return yoga(req, serverCtx);
  };
}

/**
 * spec/04：默认自定义掩码（原样透出 + 权限错误 403）；maskedErrors 直通 Yoga，maskError 单独覆盖
 * （Yoga v5 只认对象形态，传裸函数会被静默忽略退回默认掩码）。
 */
function resolveMaskedErrors(opts) {
  if (opts.maskedErrors !== undefined) return opts.maskedErrors;
  return { maskError: opts.maskError || defaultMaskError };
}

/** 装配 Yoga 实例：schema 构建 + 深度/字段守卫插件 + 掩码 + 可选端点 */
function createYoga(store, opts = {}) {
  assertSecureConfig(store, opts);
  const policyProvider = opts.policyProvider || null;
  const withScopeFn = policyProvider ? resolveWithScope(store) : null;
  const { createYoga: createYogaImpl } = loadYoga();
  const schema = opts.schema || buildGraphQLSchema(store, opts);
  const depthLimit = opts.maxQueryDepth != null ? opts.maxQueryDepth : MAX_QUERY_DEPTH;
  const fieldsLimit = opts.maxQueryFields != null ? opts.maxQueryFields : MAX_QUERY_FIELDS;
  const introspectionEnabled = opts.introspection !== false;
  const yoga = createYogaImpl({
    schema,
    logging: opts.logging != null ? opts.logging : false,
    // spec/04：请求体上限 1MB(Yoga 默认 25MB,显式收窄对齐 store-api 三端)
    maxRequestBodySize: 1 << 20,
    maskedErrors: resolveMaskedErrors(opts),
    plugins: [guardPlugin(depthLimit, fieldsLimit, introspectionEnabled)],
    // spec/04：context 在包装层注入（Yoga 的 context factory 无法自定义 HTTP 状态码）
    context: undefined,
    // 承载端点（Yoga 原生选项 graphqlEndpoint；缺省 /graphql。store-gateway 组合时透传自定义路径）
    ...(opts.endpoint ? { graphqlEndpoint: opts.endpoint } : {}),
  });
  return { yoga: createHandler(store, yoga, opts, policyProvider, withScopeFn), schema };
}

module.exports = {
  assertSecureConfig,
  resolveWithScope,
  loadYoga,
  assertDepth,
  assertFieldBudget,
  guardPlugin,
  applyContext,
  createHandler,
  resolveMaskedErrors,
  createYoga,
};
