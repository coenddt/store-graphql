'use strict';

/**
 * 冒烟测试 — mock store（不连真实库，不依赖 rust core 绑定）。
 * 用例语义与 ../conformance/cases/users-graphql.json 对齐（spec 唯一事实源）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { parse, execute } = require('graphql');
const {
  buildGraphQLSchema,
  createYoga,
  exportSDL,
  filterArchived,
} = require('../src/index');

const DEFN = {
  name: 'User',
  description: '用户表：平台账号主档',
  fields: {
    _id: { type: 'string', description: '主键，u 前缀' },
    name: { type: 'string' },
    age: { type: 'int' },
    profile: { type: 'object', description: '个人资料', fields: { bio: { type: 'string' } } },
  },
};

// 内存版 store：query 按「模型+条件」匹配，记录 GQL 串供断言投影下推
function makeMockStore() {
  const rows = [];
  const gqlLog = [];
  return {
    rows,
    gqlLog,
    list: () => ['User'],
    get: () => DEFN,
    async query(gql, params) {
      gqlLog.push({ gql, params });
      const cond = params && params.c0;
      return rows.filter((r) => !cond || Object.entries(cond).every(([k, v]) => r[k] === v));
    },
    async insert(_name, data) {
      const doc = { _id: `u${rows.length + 1}`, ...data };
      rows.push(doc);
      return doc;
    },
    async update(_name, cond, data) {
      const row = rows.find((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      Object.assign(row, data);
      return row;
    },
    async remove(_name, cond) {
      const i = rows.findIndex((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      if (i >= 0) rows.splice(i, 1);
    },
    setContext() {},
  };
}

async function run(schema, query, variableValues) {
  const result = await execute({
    schema,
    document: parse(query),
    variableValues,
  });
  if (result.errors && result.errors.length) {
    throw new Error(`GraphQL 执行失败: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  return result.data;
}

test('fail-secure 装配守卫：requireContext=true 且无 contextFactory ⇒ ERR_SECURE_CONFIG（先于 yoga 加载）', () => {
  const closed = makeMockStore();
  closed.requireContext = () => true;
  // 无 contextFactory：守卫在 require graphql-yoga 之前抛错（fail-fast，无额外依赖）
  assert.throws(() => createYoga(closed), /ERR_SECURE_CONFIG/);
  // 补配 contextFactory：越过守卫（是否缺 yoga 由环境决定，但不再是配置错误）
  assert.doesNotThrow(
    () => createYoga(closed, { contextFactory: () => ({ uid: 'u1' }) }),
    /ERR_SECURE_CONFIG/,
  );
  // 默认姿态 requireContext=false：守卫不触发
  const opened = makeMockStore();
  opened.requireContext = () => false;
  assert.doesNotThrow(() => createYoga(opened), /ERR_SECURE_CONFIG/);
});

test('filterArchived 归档表过滤（spec/01）', () => {
  assert.deepEqual(filterArchived(['User', 'UserDeleted', 'Log']), ['User', 'Log']);
});

test('SDL 自动生成：类型映射与生成面（spec/01）', async () => {
  const store = makeMockStore();
  const sdl = exportSDL(buildGraphQLSchema(store));
  assert.match(sdl, /type User \{/);
  assert.match(sdl, /get_User\(id: ID!\): User/);
  assert.match(sdl, /list_User\(condition: JSON, sort: JSON, limit: Int\): \[User!\]!/);  assert.match(sdl, /create_User\(input: JSON!\): User/);
  assert.match(sdl, /profile: User_profile/); // 嵌套 object 下钻
  // description 管道（spec/05）：模型/字段/嵌套类型三层透传
  assert.match(sdl, /"""用户表：平台账号主档"""/);
  assert.match(sdl, /"""主键，u 前缀"""/);
  assert.match(sdl, /"""个人资料"""/);
  assert.doesNotMatch(sdl, /SecretLog/);
});

test('create + list：投影下推与数据回放（spec/02）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  const created = await run(
    schema,
    'mutation($input: JSON!) { create_User(input: $input) { _id name age } }',
    { input: { name: 'a', age: 1 } }
  );
  assert.equal(created.create_User.name, 'a');
  assert.equal(created.create_User._id, 'u1');

  const listed = await run(
    schema,
    'query($c: JSON, $l: Int) { list_User(condition: $c, limit: $l) { name profile { bio } } }',
    { c: { name: 'a' }, l: 10 }
  );
  assert.equal(listed.list_User.length, 1);
  assert.equal(listed.list_User[0].name, 'a');

  // 投影下推断言：selection 被编入 GQL 串，参数按需拼接（spec/02 映射表）
  const last = store.gqlLog.at(-1);
  assert.equal(last.gql, 'User($condition:@c0,$limit:@l) { name, profile { bio } }');
  assert.deepEqual(last.params, { c0: { name: 'a' }, l: 10 });
});

test('get/update/delete 全链路 + 回读（spec/02）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  await run(schema, 'mutation($input: JSON!) { create_User(input: $input) { _id } }', { input: { name: 'b' } });

  const got = await run(schema, '{ get_User(id: "u1") { name } }');
  assert.equal(got.get_User.name, 'b');

  const updated = await run(
    schema,
    'mutation($id: ID!, $set: JSON!) { update_User(id: $id, set: $set) { name age } }',
    { id: 'u1', set: { age: 2 } }
  );
  assert.equal(updated.update_User.age, 2);

  const del = await run(schema, 'mutation { delete_User(id: "u1") }');
  assert.equal(del.delete_User, true);
  const listed = await run(schema, '{ list_User { _id } }');
  assert.equal(listed.list_User.length, 0);
});

test('@skip/@include 与 fragment（spec/02 序列化规则）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  await run(schema, 'mutation($input: JSON!) { create_User(input: $input) { _id } }', { input: { name: 'c' } });
  await run(
    schema,
    `query($noAge: Boolean!) {
      list_User {
        name
        age @skip(if: $noAge)
        ...U
      }
    }
    fragment U on User { name }`,
    { noAge: true }
  );
  assert.equal(store.gqlLog.at(-1).gql, 'User($limit:@l) { name, name }'); // skip 生效+缺省 limit(spec/02);fragment 展开后 name 重复由 core 侧投影去重容忍
});

test('limit 守卫：缺省 50 / 超限 ERR_LIMIT: / 边界 1000（spec/02）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  await run(schema, 'mutation($input: JSON!) { create_User(input: $input) { _id } }', { input: { name: 'd' } });

  // 缺省 → 恒拼接 $limit:@l 且 params.l = 50
  await run(schema, '{ list_User { _id } }');
  let last = store.gqlLog.at(-1);
  assert.equal(last.gql, 'User($limit:@l) { _id }');
  assert.equal(last.params.l, 50);

  // 边界 1000 → 通过
  await run(schema, 'query($l: Int) { list_User(limit: $l) { _id } }', { l: 1000 });
  assert.equal(store.gqlLog.at(-1).params.l, 1000);

  // 超限 → resolver 抛错进 errors 数组（ERR_LIMIT: 稳定前缀），不静默截断
  const result = await execute({
    schema,
    document: parse('query($l: Int) { list_User(limit: $l) { _id } }'),
    variableValues: { l: 1001 },
  });
  assert.ok(result.errors && result.errors[0].message.includes('ERR_LIMIT:'), '超限应带 ERR_LIMIT: 前缀');
  assert.equal(result.data, null); // list_User 非空 ⇒ 错误冒泡至根,data 整体为 null
});

test('x-graphql 注记：hidden / readonly（spec/03 钩子 1）', async () => {
  const store = makeMockStore();
  const hidden = { ...DEFN, name: 'SecretLog', 'x-graphql': { hidden: true } };
  const readonly = { ...DEFN, name: 'AuditEvent', 'x-graphql': { readonly: true } };
  store.list = () => ['User', 'SecretLog', 'AuditEvent'];
  store.get = (n) => (n === 'User' ? DEFN : n === 'SecretLog' ? hidden : readonly);
  const sdl = exportSDL(buildGraphQLSchema(store));
  assert.doesNotMatch(sdl, /SecretLog/);
  assert.match(sdl, /get_AuditEvent/);
  assert.doesNotMatch(sdl, /create_AuditEvent/);
});

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
  assert.equal(queryDepthOf(parse('{ list_User { _id } }')), 2);
  // fragment 深度计入(非环)+ 环引用给有限值不崩
  assert.equal(queryDepthOf(parse('query { ...A } fragment A on Query { list_User { _id } }')), 2);
  assert.equal(queryDepthOf(parse('query { ...A } fragment A on Query { list_User { ...A } }')), 1);

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
  const ok = await post('{ list_User { _id } }'); // 深度 2,放行
  assert.equal(ok.status, 200);
  const deep3 = await post('{ list_User { profile { bio } } }'); // 深度 3,拒
  assert.equal(deep3.status, 400);
  const body = await deep3.json();
  assert.ok(body.errors[0].message.includes('ERR_DEPTH:'));
});

test('复杂度与 introspection 守卫（spec/04）', async () => {
  const { queryFieldCount, createYoga } = require('../src/index');
  const doc = parse('{ list_User { _id } }');
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
  assert.equal((await post('{ list_User { _id } }')).status, 200);
  const over = await post('{ list_User { _id name } }');
  assert.equal(over.status, 400);
  assert.ok((await over.json()).errors[0].message.includes('ERR_COMPLEXITY:'));

  // __typename 放行(无泄露面);__schema ⇒ 400 + ERR_INTROSPECTION:
  assert.equal((await post('{ __typename }')).status, 200);
  const intro = await post('{ __schema { queryType { name } } }');
  assert.equal(intro.status, 400);
  assert.ok((await intro.json()).errors[0].message.includes('ERR_INTROSPECTION:'));
});

test('override / extend（spec/03 钩子 2、3）与未知路径校验', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store, {
    overrides: {
      'Query.list_User': async () => [{ _id: 'x', name: 'override', age: 0, profile: null }],
    },
    extensions: {
      Query: {
        ping: { type: require('graphql').GraphQLBoolean, resolve: () => true },
      },
    },
  });
  const data = await run(schema, '{ list_User { name } ping }');
  assert.equal(data.list_User[0].name, 'override');
  assert.equal(data.ping, true);

  assert.throws(
    () => buildGraphQLSchema(store, { overrides: { 'Query.list_Nope': async () => [] } }),
    /未命中/
  );
});

// ── spec/04：HTTP 承载（graphqlPlugin，Fastify 插件）──

async function makeApp(opts) {
  const app = require('fastify')({ logger: false });
  await app.register(require('../src/index').graphqlPlugin, opts);
  await app.ready();
  return app;
}

const gqlPost = (url, query) => ({
  method: 'POST',
  url,
  headers: { 'content-type': 'application/json' },
  payload: { query },
});

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

test('graphqlPlugin 错误呈现：权限错误 403 + FORBIDDEN，message 原样（spec/04）', async () => {
  const app = await makeApp({
    store: makeMockStore(),
    overrides: {
      'Query.list_User': () => {
        throw new Error('ERR_PERMISSION:无访问权限');
      },
    },
  });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ list_User { _id } }'));
    assert.equal(res.statusCode, 403);
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
      'Query.list_User': () => {
        throw new Error('boom detail');
      },
    },
  });
  try {
    const res = await app.inject(gqlPost('/graphql', '{ list_User { _id } }'));
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
