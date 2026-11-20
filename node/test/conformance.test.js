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
const { makeGqlMockStore } = require('./helpers/gql-test-helpers');

function makeStore(schemaDefn) {
  return makeGqlMockStore({
    names: [schemaDefn.name],
    schemaDefn,
    idOf: () => 'u1',
  });
}

/** 断言该步以指定错误前缀失败 */
function assertStepError(step, i, result) {
  const errors = result.errors || [];
  assert.ok(
    errors.length > 0 && errors[0].message.startsWith(step.expect.errorCodePrefix),
    `step#${i} 应抛 ${step.expect.errorCodePrefix},实际: ${errors.map((e) => e.message).join('; ')}`
  );
}

/** 断言该步无错，并校验 dataKeys / 投影下推串 / params.l */
function assertStepResult(step, i, store, result) {
  const errors = result.errors || [];
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
  const exp = step.expect;
  if (exp.pageField) {
    const page = data[exp.pageField] || {};
    if (exp.total != null) assert.equal(page.total, exp.total, `step#${i} total 不符`);
    if (exp.hasMore != null) assert.equal(page.hasMore, exp.hasMore, `step#${i} hasMore 不符`);
    if (exp.page != null) assert.equal(page.page, exp.page, `step#${i} page 不符`);
    if (exp.pageSize != null) assert.equal(page.pageSize, exp.pageSize, `step#${i} pageSize 不符`);
    if (exp.itemsLength != null) {
      assert.equal((page.items || []).length, exp.itemsLength, `step#${i} itemsLength 不符`);
    }
  }
  if (exp.paramsPage != null) {
    assert.equal(store.gqlLog.at(-1).params.page, exp.paramsPage, `step#${i} params.page 不符`);
  }
  if (exp.paramsPageSize != null) {
    assert.equal(store.gqlLog.at(-1).params.pageSize, exp.paramsPageSize, `step#${i} params.pageSize 不符`);
  }
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
    if (step.expect.errorCodePrefix) {
      assertStepError(step, i, result);
      continue;
    }
    assertStepResult(step, i, store, result);
  }
});
