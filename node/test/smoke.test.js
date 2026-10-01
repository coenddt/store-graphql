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
  assert.equal(store.gqlLog.at(-1).gql, 'User { name, name }'); // skip 生效；fragment 展开后 name 重复由 core 侧投影去重容忍
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
