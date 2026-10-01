'use strict';

/**
 * conformance runner — 直接消费 ../conformance/cases/*.json 执行断言(store-graphql v1 口径)。
 * 三端 runner 同构:同一份用例,同一套 expect 契约(dataKeys/gql/paramsLimit/errorCodePrefix)。
 * 语义变更必须先改 spec/,再改 cases/,再三端 runner——三者不一致即为缺陷。
 */

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parse, execute } = require('graphql');
const { buildGraphQLSchema } = require('../src/index');

const CASES_DIR = join(__dirname, '..', '..', 'conformance', 'cases');
const c = JSON.parse(readFileSync(join(CASES_DIR, 'users-graphql.json'), 'utf8'));

function makeStore(schemaDefn) {
  const rows = [];
  const gqlLog = [];
  return {
    rows,
    gqlLog,
    list: () => [schemaDefn.name],
    get: () => schemaDefn,
    async query(gql, params) {
      gqlLog.push({ gql, params });
      const cond = params && params.c0;
      return rows.filter((r) => !cond || Object.entries(cond).every(([k, v]) => r[k] === v));
    },
    async insert(_name, data) {
      const doc = { _id: 'u1', ...data };
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

test(`conformance: ${c.name}`, async () => {
  const store = makeStore(c.schema);
  const schema = buildGraphQLSchema(store);
  for (const [i, step] of c.steps.entries()) {
    const result = await execute({
      schema,
      document: parse(step.query),
      variableValues: step.variables || {},
    });
    const errors = result.errors || [];
    if (step.expect.errorCodePrefix) {
      assert.ok(
        errors.length > 0 && errors[0].message.startsWith(step.expect.errorCodePrefix),
        `step#${i} 应抛 ${step.expect.errorCodePrefix},实际: ${errors.map((e) => e.message).join('; ')}`
      );
      continue;
    }
    assert.deepEqual(errors, [], `step#${i} 不应有错误: ${errors.map((e) => e.message).join('; ')}`);
    const data = result.data || {};
    for (const key of step.expect.dataKeys || []) {
      assert.ok(key in data, `step#${i} data 缺少 ${key}`);
    }
    if (step.expect.gql) {
      assert.equal(store.gqlLog.at(-1).gql, step.expect.gql, `step#${i} 投影下推串不符`);
    }
    if (step.expect.paramsLimit != null) {
      assert.equal(store.gqlLog.at(-1).params.l, step.expect.paramsLimit, `step#${i} params.l 不符`);
    }
  }
});
