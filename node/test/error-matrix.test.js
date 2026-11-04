'use strict';

/**
 * 映射矩阵：每档上下文错误语义 → GraphQL HTTP 状态码（A3「可程序化区分」验收）。
 * 走 createYoga 包装层（contextFactory 抛错分类），无需真实库；用例与 py/tests/test_error_matrix.py 同构。
 * 规范依据：spec/04-errors-context.md（权限类含 NoContext ⇒ 403；其余 ⇒ 401）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createYoga } = require('../src/index');

const DEFN = { name: 'User', fields: { _id: { type: 'string' } } };
const makeStore = () => ({ list: () => ['User'], get: () => DEFN, setContext() {} });

const mkRequest = (user) =>
  new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify({ query: '{ __typename }' }),
  });

test('映射矩阵：Permission 档 → 403；NoContext 档 → 403；其余 → 401', async () => {
  const { yoga } = createYoga(makeStore(), {
    contextFactory: async ({ request }) => {
      const user = request.headers.get('x-user');
      if (user === 'perm') throw new Error('ERR_PERMISSION:无访问权限');
      if (user === 'nocontext') {
        const e = new Error('上下文缺失');
        e.name = 'NoContextError';
        e.code = 'no_context';
        throw e;
      }
      if (user === 'broken') throw new Error('上下文钩子故障');
      return { user };
    },
  });

  assert.equal((await yoga(mkRequest('perm'))).status, 403);
  assert.equal((await yoga(mkRequest('nocontext'))).status, 403);
  assert.equal((await yoga(mkRequest('broken'))).status, 401);
  assert.equal((await yoga(mkRequest('alice'))).status, 200);
});

const mkQueryRequest = (query) =>
  new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

const makeQueryStore = (errFactory) => ({
  list: () => ['User'],
  get: () => DEFN,
  setContext() {},
  query: async () => {
    throw errFactory();
  },
});

test('非权限 ERR_* 前缀补 extensions.code（message 原样保留）', async () => {
  const { yoga } = createYoga(
    makeQueryStore(() => new Error(
      'ERR_NOT_FOUND:目标记录不存在（写条件未命中任何行，_id 不存在或已被删除）',
    )),
    { contextFactory: async () => ({ user: 'u1' }) },
  );
  const res = await yoga(mkQueryRequest('{ listUser { _id } }'));
  assert.equal(res.status, 200);
  const err = (await res.json()).errors[0];
  assert.equal(err.extensions.code, 'NOT_FOUND');
  assert.ok(err.message.startsWith('ERR_NOT_FOUND:'), err.message);
});

test('越权错误保持原权限 code / message（不被非权限映射改写）', async () => {
  const { yoga } = createYoga(
    makeQueryStore(() => new Error('ERR_PERMISSION:RBAC:无权写入')),
    { contextFactory: async () => ({ user: 'u1' }) },
  );
  const res = await yoga(mkQueryRequest('{ listUser { _id } }'));
  assert.equal(res.status, 403);
  const err = (await res.json()).errors[0];
  assert.equal(err.extensions.code, 'FORBIDDEN');
  assert.equal(err.message, 'ERR_PERMISSION:RBAC:无权写入');
});