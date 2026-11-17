'use strict';

/**
 * 冒烟测试 — mock store（不连真实库，不依赖 rust core 绑定）。
 * 用例语义与 ../conformance/cases/users-graphql.json 对齐（spec 唯一事实源）。
 *
 * D4-4 零语义拆分：HTTP 承载 / 查询守卫用例迁至 http-guards.test.js，
 * policyProvider 用例迁至 policy-provider.test.js；makeMockStore / makeApp /
 * gqlPost 下沉 ./helpers/gql-test-helpers.js。本文件保留 schema/SDL/CRUD/limit 用例。
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
const { DEFN, makeMockStore, runQuery: run } = require('./helpers/gql-test-helpers');

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

test('schema 过滤：`__` 前缀控制面内建模型不得进 GraphQL schema（introspection 保留）', () => {
  const store = makeMockStore();
  store.list = () => ['User', 'UserDeleted', '__workflowRun', '__feedback'];
  const schema = buildGraphQLSchema(store);
  assert.ok(schema.getType('User'));
  assert.equal(schema.getType('__workflowRun'), undefined);
  assert.equal(schema.getType('__feedback'), undefined);
  assert.equal(schema.getQueryType().getFields().list_workflowRun, undefined);
  // 显式 resources 入参同样过滤（spec/01）
  const explicit = buildGraphQLSchema(store, { resources: ['User', '__workflowRun'] });
  assert.ok(explicit.getType('User'));
  assert.equal(explicit.getType('__workflowRun'), undefined);
  // 显式点名归档表同样被归档过滤（spec/01，行为修正：原实现显式入参跳过归档过滤）
  const archived = buildGraphQLSchema(store, { resources: ['User', 'UserDeleted'] });
  assert.ok(archived.getType('User'));
  assert.equal(archived.getType('UserDeleted'), undefined);
  // spec/01：显式开关 includeArchived:true 才放行归档表（默认仍过滤）
  const withArchived = buildGraphQLSchema(store, {
    resources: ['User', 'UserDeleted', '__workflowRun'],
    includeArchived: true,
  });
  assert.ok(withArchived.getType('UserDeleted'));
  assert.equal(withArchived.getType('__workflowRun'), undefined); // `__` 过滤不受开关影响
});

test('SDL 自动生成：类型映射与生成面（spec/01）', async () => {
  const store = makeMockStore();
  const sdl = exportSDL(buildGraphQLSchema(store));
  assert.match(sdl, /type User \{/);
  assert.match(sdl, /getUser\(id: ID!\): User/);
  assert.match(sdl, /listUser\(condition: JSON, sort: JSON, limit: Int\): \[User!\]!/);  assert.match(sdl, /createUser\(input: JSON!\): User/);
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
    'mutation($input: JSON!) { createUser(input: $input) { _id name age } }',
    { input: { name: 'a', age: 1 } }
  );
  assert.equal(created.createUser.name, 'a');
  assert.equal(created.createUser._id, 'u1');

  const listed = await run(
    schema,
    'query($c: JSON, $l: Int) { listUser(condition: $c, limit: $l) { name profile { bio } } }',
    { c: { name: 'a' }, l: 10 }
  );
  assert.equal(listed.listUser.length, 1);
  assert.equal(listed.listUser[0].name, 'a');

  // 投影下推断言：selection 被编入 GQL 串，参数按需拼接（spec/02 映射表）
  const last = store.gqlLog.at(-1);
  assert.equal(last.gql, 'User($condition:@c0,$limit:@l) { name, profile { bio } }');
  assert.deepEqual(last.params, { c0: { name: 'a' }, l: 10 });
});

test('get/update/delete 全链路 + 回读（spec/02）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  await run(schema, 'mutation($input: JSON!) { createUser(input: $input) { _id } }', { input: { name: 'b' } });

  const got = await run(schema, '{ getUser(id: "u1") { name } }');
  assert.equal(got.getUser.name, 'b');

  const updated = await run(
    schema,
    'mutation($id: ID!, $set: JSON!) { updateUser(id: $id, set: $set) { name age } }',
    { id: 'u1', set: { age: 2 } }
  );
  assert.equal(updated.updateUser.age, 2);

  const del = await run(schema, 'mutation { deleteUser(id: "u1") }');
  assert.equal(del.deleteUser, true);
  const listed = await run(schema, '{ listUser { _id } }');
  assert.equal(listed.listUser.length, 0);
});

test('@skip/@include 与 fragment（spec/02 序列化规则）', async () => {
  const store = makeMockStore();
  const schema = buildGraphQLSchema(store);
  await run(schema, 'mutation($input: JSON!) { createUser(input: $input) { _id } }', { input: { name: 'c' } });
  await run(
    schema,
    `query($noAge: Boolean!) {
      listUser {
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
  await run(schema, 'mutation($input: JSON!) { createUser(input: $input) { _id } }', { input: { name: 'd' } });

  // 缺省 → 恒拼接 $limit:@l 且 params.l = 50
  await run(schema, '{ listUser { _id } }');
  let last = store.gqlLog.at(-1);
  assert.equal(last.gql, 'User($limit:@l) { _id }');
  assert.equal(last.params.l, 50);

  // 边界 1000 → 通过
  await run(schema, 'query($l: Int) { listUser(limit: $l) { _id } }', { l: 1000 });
  assert.equal(store.gqlLog.at(-1).params.l, 1000);

  // 超限 → resolver 抛错进 errors 数组（ERR_LIMIT: 稳定前缀），不静默截断
  const result = await execute({
    schema,
    document: parse('query($l: Int) { listUser(limit: $l) { _id } }'),
    variableValues: { l: 1001 },
  });
  assert.ok(result.errors && result.errors[0].message.includes('ERR_LIMIT:'), '超限应带 ERR_LIMIT: 前缀');
  assert.equal(result.data, null); // listUser 非空 ⇒ 错误冒泡至根,data 整体为 null
});

test('x-graphql 注记：hidden / readonly（spec/03 钩子 1）', async () => {
  const store = makeMockStore();
  const hidden = { ...DEFN, name: 'SecretLog', 'x-graphql': { hidden: true } };
  const readonly = { ...DEFN, name: 'AuditEvent', 'x-graphql': { readonly: true } };
  store.list = () => ['User', 'SecretLog', 'AuditEvent'];
  store.get = (n) => (n === 'User' ? DEFN : n === 'SecretLog' ? hidden : readonly);
  const sdl = exportSDL(buildGraphQLSchema(store));
  assert.doesNotMatch(sdl, /SecretLog/);
  assert.match(sdl, /getAuditEvent/);
  assert.doesNotMatch(sdl, /createAuditEvent/);
});
