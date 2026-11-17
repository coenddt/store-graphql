'use strict';

/**
 * store-graphql policyProvider 请求入口作用域化测试（D4-4 零语义拆分）。
 * 自 smoke.test.js 原样迁出 R2-04 两用例，用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createYoga } = require('../src/index');
const { makeMockStore, makeApp, gqlPost } = require('./helpers/gql-test-helpers');

// ── R2-04：policyProvider 请求入口作用域化（与 store-api/node/test 同构，双端 parity）──

test('policyProvider 装配守卫 + requireContext 覆盖：无 ctx 请求 → no_context(403)；返回 null → 行为同现状', async (t) => {
  // policyProvider 流程依赖宿主 nodejs-store 的 withScope 作用域原语（optional peer，CI 不安装）；
  // 宿主不可解析 ⇒ 显式 skip（与 e2e.real.test.js 同惯例，本地 workspace 仍全量验证）
  let currentView;
  try {
    currentView = require('nodejs-store').currentView;
  } catch {
    return t.skip('[环境依赖] nodejs-store(optional peer) 不可解析：CI 无宿主包，policyProvider 流程本地验证');
  }

  // 装配守卫：宿主未导出 baseView() 时注入 policyProvider ⇒ 装配期显式失败（fail-fast，禁静默降级）
  const legacy = makeMockStore();
  assert.throws(
    () => createYoga(legacy, { policyProvider: () => null }),
    /ERR_POLICY_PROVIDER_CONFIG/,
  );

  const store = makeMockStore();
  store.baseView = () => ({ withPolicy: (o) => ({ overrides: o }) });
  store.setContext = (ctx) => { store.lastContext = ctx; };
  // 作用域感知的 query（模拟宿主 fail-secure：视图要求 ctx 且当前 ctx 缺失 ⇒ NoContext）
  store.query = async () => {
    const view = currentView();
    if (view && view.overrides && view.overrides.requireContext && store.lastContext == null) {
      const e = new Error('ERR_NO_CONTEXT:上下文缺失');
      e.code = 'no_context';
      throw e;
    }
    return [...store.rows.values()];
  };

  // ① 注入 requireContext 覆盖：未配 contextFactory（policyProvider 收到 null）→ 403 no_context
  let seenCtx = 'unset';
  const app = await makeApp({
    store,
    policyProvider: (ctx) => { seenCtx = ctx; return { requireContext: true }; },
  });
  try {
    const denied = await app.inject(gqlPost('/graphql', '{ listUser { _id } }'));
    assert.equal(seenCtx, null); // policyProvider 入参 = 已解析 ctx（无 contextFactory ⇒ null）
    assert.equal(denied.statusCode, 403);
    const err = denied.json().errors[0];
    assert.equal(err.extensions.code, 'FORBIDDEN');
    assert.ok(err.message.includes('ERR_NO_CONTEXT'));
  } finally {
    await app.close();
  }

  // ② 注入返回 null ⇒ 无视图作用域（currentView() 回退 base）→ 行为同现状
  const lax = await makeApp({ store, policyProvider: () => null });
  try {
    const ok = await lax.inject(gqlPost('/graphql', '{ listUser { _id } }'));
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().errors, undefined);
  } finally {
    await lax.close();
  }
});

test('policyProvider：profile 覆盖经视图生效（查询面可观察）；ctx 复用自 contextFactory（禁二次调用）', async (t) => {
  let currentView;
  try {
    currentView = require('nodejs-store').currentView;
  } catch {
    return t.skip('[环境依赖] nodejs-store(optional peer) 不可解析：CI 无宿主包，policyProvider 流程本地验证');
  }
  const store = makeMockStore();
  store.baseView = () => ({ withPolicy: (o) => ({ overrides: o }) });
  // 档位判决可观察面：text2query 档视图下输出收缩（模拟 core 判决差异经宿主查询面可见）
  store.query = async () => {
    const view = currentView();
    if (view && view.overrides && view.overrides.profile === 'text2query') {
      return [{ _id: 'r1', name: 'redacted' }];
    }
    return [...store.rows.values()];
  };
  let ctxCalls = 0;
  const app = await makeApp({
    store,
    contextFactory: () => { ctxCalls += 1; return { uid: 'u9' }; },
    policyProvider: (ctx) => (ctx && ctx.uid === 'u9' ? { profile: 'text2query' } : null),
  });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ listUser { _id name } }'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.listUser, [{ _id: 'r1', name: 'redacted' }]);
    // 单请求 contextFactory 恰好解析一次（handler 层已解析值复用，禁二次调用）
    assert.equal(ctxCalls, 1);
  } finally {
    await app.close();
  }
});
