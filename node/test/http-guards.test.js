'use strict';

/**
 * store-graphql HTTP 承载与查询守卫测试（D4-4 零语义拆分）。
 * 自 smoke.test.js 原样迁出 Yoga 上下文错误分类、深度/复杂度/introspection
 * 守卫、override/extend 与 graphqlPlugin 用例，用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { parse } = require('graphql');
const { buildGraphQLSchema } = require('../src/index');
const {
  makeMockStore, runQuery: run, makeApp, gqlPost,
} = require('./helpers/gql-test-helpers');

test('createYoga 上下文错误分类 403/401（spec/04，core ERR_PERMISSION: 前缀契约）', async () => {
  const { createYoga } = require('../src/index');
  const store = makeMockStore();
  const { yoga } = createYoga(store, {
    contextFactory: async ({ request }) => {
      const user = request.headers.get('x-user');
      if (user === 'bad') throw new Error('ERR_PERMISSION:无访问权限');
      if (user === 'broken') throw new Error('上下文钩子故障');
      return { user };
    },
  });
  const mk = (u) =>
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': u },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
  const r403 = await yoga(mk('bad'));
  assert.equal(r403.status, 403);
  const r401 = await yoga(mk('broken'));
  assert.equal(r401.status, 401);
  const ok = await yoga(mk('alice'));
  assert.equal(ok.status, 200);

  // 请求体上限 1MB（spec/04；Yoga maxRequestBodySize 显式收窄自默认 25MB）
  const big = JSON.stringify({
    query: '{ __typename }'.padEnd((1 << 20) + 100, ' '),
  });
  const r413 = await yoga(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: big,
    })
  );
  assert.equal(r413.status, 413);
});

test('查询深度守卫：算法单元 + HTTP 层 400（spec/04）', async () => {
  const { queryDepthOf, createYoga } = require('../src/index');

  // 单元:11 层纯 AST(不经 schema 校验)
  const deepQ = '{ ' + 'a { '.repeat(10) + 'x ' + '}'.repeat(10) + ' }';
  assert.equal(queryDepthOf(parse(deepQ)), 11);
  assert.equal(queryDepthOf(parse('{ listUser { _id } }')), 2);
  // fragment 深度计入(非环)+ 环引用给有限值不崩
  assert.equal(queryDepthOf(parse('query { ...A } fragment A on Query { listUser { _id } }')), 2);
  assert.equal(queryDepthOf(parse('query { ...A } fragment A on Query { listUser { ...A } }')), 1);

  // HTTP 层:maxQueryDepth=2,深度 3 的合法查询 ⇒ 400 + ERR_DEPTH:
  const store = makeMockStore();
  const { yoga } = createYoga(store, { maxQueryDepth: 2 });
  const post = (query) =>
    yoga(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
    );
  const ok = await post('{ listUser { _id } }'); // 深度 2,放行
  assert.equal(ok.status, 200);
  const deep3 = await post('{ listUser { profile { bio } } }'); // 深度 3,拒
  assert.equal(deep3.status, 400);
  const body = await deep3.json();
  assert.ok(body.errors[0].message.includes('ERR_DEPTH:'));
  // 旧值原地不动 + 规范化码另置（兼容既有按 ERR_ 前缀匹配的调用方）
  assert.equal(body.errors[0].extensions.code, 'ERR_DEPTH');
  assert.equal(body.errors[0].extensions.normalizedCode, 'DEPTH');
});

test('复杂度与 introspection 守卫（spec/04）', async () => {
  const { queryFieldCount, createYoga } = require('../src/index');
  const doc = parse('{ listUser { _id } }');
  assert.equal(queryFieldCount(doc).fields, 2);
  assert.equal(queryFieldCount(parse('{ __schema { queryType { name } } }')).introspectionUsed, true);

  const store = makeMockStore();
  const { yoga } = createYoga(store, { maxQueryFields: 2, introspection: false });
  const post = (query) =>
    yoga(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
    );

  // 字段数 = 2(边界)放行;3 超限 ⇒ 400 + ERR_COMPLEXITY:
  assert.equal((await post('{ listUser { _id } }')).status, 200);
  const over = await post('{ listUser { _id name } }');
  assert.equal(over.status, 400);
  const overBody = await over.json();
  assert.ok(overBody.errors[0].message.includes('ERR_COMPLEXITY:'));
  assert.equal(overBody.errors[0].extensions.code, 'ERR_COMPLEXITY');
  assert.equal(overBody.errors[0].extensions.normalizedCode, 'COMPLEXITY');

  // __typename 放行(无泄露面);__schema ⇒ 400 + ERR_INTROSPECTION:
  assert.equal((await post('{ __typename }')).status, 200);
  const intro = await post('{ __schema { queryType { name } } }');
  assert.equal(intro.status, 400);
  const introBody = await intro.json();
  assert.ok(introBody.errors[0].message.includes('ERR_INTROSPECTION:'));
  assert.equal(introBody.errors[0].extensions.code, 'ERR_INTROSPECTION');
  assert.equal(introBody.errors[0].extensions.normalizedCode, 'INTROSPECTION');
});

test('override / extend（spec/03 钩子 2、3）与未知路径校验', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store, {
    overrides: {
      'Query.listUser': async () => [{ _id: 'x', name: 'override', age: 0, profile: null }],
    },
    extensions: {
      Query: {
        ping: { type: require('graphql').GraphQLBoolean, resolve: () => true },
      },
    },
  });
  const data = await run(schema, '{ listUser { name } ping }');
  assert.equal(data.listUser[0].name, 'override');
  assert.equal(data.ping, true);

  assert.throws(
    () => buildGraphQLSchema(store, { overrides: { 'Query.listNope': async () => [] } }),
    /未命中/
  );
});

// ── spec/04：HTTP 承载（graphqlPlugin，Fastify 插件）──

test('graphqlPlugin 缺省 path /graphql', async () => {
  const app = await makeApp({ store: makeMockStore() });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ __typename }'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.__typename, 'Query');
  } finally {
    await app.close();
  }
});

test('graphqlPlugin path 可配', async () => {
  const app = await makeApp({ store: makeMockStore(), path: '/gql' });
  try {
    assert.equal((await app.inject(gqlPost('/gql', '{ __typename }'))).statusCode, 200);
    assert.equal((await app.inject(gqlPost('/graphql', '{ __typename }'))).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('graphqlPlugin GET 文档页', async () => {
  const app = await makeApp({ store: makeMockStore() });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/graphql' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('graphqlPlugin 错误呈现：权限错误 200 + FORBIDDEN，message 原样（spec/04）', async () => {
  const app = await makeApp({
    store: makeMockStore(),
    overrides: {
      'Query.listUser': () => {
        throw new Error('ERR_PERMISSION:无访问权限');
      },
    },
  });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ listUser { _id } }'));
    assert.equal(res.statusCode, 200);
    const err = res.json().errors[0];
    assert.equal(err.extensions.code, 'FORBIDDEN');
    assert.equal(err.message, 'ERR_PERMISSION:无访问权限');
  } finally {
    await app.close();
  }
});

test('graphqlPlugin 错误呈现：非权限错误 message 原样（spec/04）', async () => {
  const app = await makeApp({
    store: makeMockStore(),
    overrides: {
      'Query.listUser': () => {
        throw new Error('boom detail');
      },
    },
  });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ listUser { _id } }'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().errors[0].message, 'boom detail');
  } finally {
    await app.close();
  }
});

test('graphqlPlugin 缺 store 显式报错（不静默）', async () => {
  await assert.rejects(
    () => require('../src/index').graphqlPlugin(require('fastify')({ logger: false }), {}),
    /ERR_NO_STORE/
  );
});
