'use strict';

/**
 * e2e(真实库)— nodejs-store(真实 rust core)+ better-sqlite3 内存库跑 GraphQL 全链路。
 *
 * 验证点:适配层契约(store.list()/get() 真实返回结构)、投影下推串被真实 core 接受、
 * CRUD 全链路真实落库。依赖缺失 ⇒ 显式 skip(不静默)。
 */

const test = require('node:test');
const assert = require('node:assert');
const { parse, execute } = require('graphql');

let nodejsStore;
let Database;
let skipReason = '';
try {
  try {
    nodejsStore = require('nodejs-store');
  } catch {
    nodejsStore = require('../../../nodejs-store'); // common-store 单仓开发布局
  }
  try {
    Database = require('better-sqlite3');
  } catch {
    Database = require('../../../nodejs-store/node_modules/better-sqlite3');
  }
} catch (e) {
  skipReason = `真实库依赖缺失: ${e.message}`;
}

const DEFN = {
  name: 'User',
  collection: 'users',
  idPrefix: 'u',
  fields: {
    _id: { type: 'string' },
    name: { type: 'string' },
    age: { type: 'int' },
  },
};

async function run(schema, query, variableValues) {
  const result = await execute({ schema, document: parse(query), variableValues });
  if (result.errors && result.errors.length) {
    throw new Error(`GraphQL 执行失败: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  return result.data;
}

test(
  'e2e:真实 rust core + SQLite 的 GraphQL CRUD 全链路',
  // 注意:skip 选项仅在确有原因时传——空字符串也会触发 skip 并吞掉测试体错误(node:test 行为)
  skipReason ? { skip: skipReason } : {},
  async () => {
  const Database3 = Database;
  const db = new Database3(':memory:');
  const { init, store, executors } = nodejsStore;
  // SQL 源必须传 { kind, exec } 描述符(nodejs-store README:542),不能裸传驱动实例
  await init({ default: executors.createConnection('sqlite', db) });
  store.register(DEFN);
  // nodejs-store 是数据层,从不写 DDL;generateDdl 出纯文本由应用执行(README:351)
  // 归档表 UserDeleted 由 core 自动注册(list() 可见),delete 的归档编排需要它
  db.exec(store.generateDdl('sqlite', ['User']));
  db.exec(store.generateDdl('sqlite', ['UserDeleted']));

  const { buildGraphQLSchema } = require('../src/index');
  const schema = buildGraphQLSchema(store);

  // create:真实 core 生成 _id、真实落库
  const created = await run(
    schema,
    'mutation($input: JSON!) { createUser(input: $input) { _id name age } }',
    { input: { name: 'alice', age: 30 } }
  );
  assert.ok(created.createUser._id, '应返回真实生成的 _id');
  assert.equal(created.createUser.name, 'alice');
  const realId = created.createUser._id;

  // list:投影下推串经真实 core 解析并走 SQLite
  const listed = await run(schema, '{ listUser { _id name } }');
  assert.equal(listed.listUser.length, 1);
  assert.equal(listed.listUser[0].name, 'alice');

  // get:条件投影
  const got = await run(schema, `{ getUser(id: "${realId}") { name age } }`);
  assert.equal(got.getUser.name, 'alice');
  assert.equal(got.getUser.age, 30);

  // update:写入 + 回读
  const updated = await run(
    schema,
    'mutation($id: ID!, $set: JSON!) { updateUser(id: $id, set: $set) { name age } }',
    { id: realId, set: { age: 31 } }
  );
  assert.equal(updated.updateUser.age, 31);

  // delete:真实删除后列表为空
  const del = await run(schema, `mutation { deleteUser(id: "${realId}") }`);
  assert.equal(del.deleteUser, true);
  const after = await run(schema, '{ listUser { _id } }');
  assert.equal(after.listUser.length, 0);

  db.close();
});
