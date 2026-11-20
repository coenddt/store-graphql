'use strict';

/**
 * smoke / conformance / e2e.real 共用的 GraphQL 测试辅助：
 * 内存版 store（query 按「模型+条件」匹配并记录 GQL 串供断言投影下推）
 * 与 execute 执行器（错误聚合为单条 Error 上抛）。
 *
 * D4-4：makeMockStore / makeApp / gqlPost 自 smoke.test.js 下沉（桩体逐字，
 * src 相对路径随层级加深一级）。
 */

const { parse, execute } = require('graphql');

/**
 * 内存版 store：insert 的 _id 由 idOf(rows) 决定
 * （smoke 序号递增 u1/u2…，conformance 恒 u1）；list/get 由调用方注入。
 */
function makeGqlMockStore({ names, schemaDefn, idOf }) {
  const rows = [];
  const gqlLog = [];
  return {
    rows,
    gqlLog,
    list: () => names,
    get: () => schemaDefn,
    async query(gql, params) {
      gqlLog.push({ gql, params });
      const cond = params && params.c0;
      return rows.filter((r) => !cond || Object.entries(cond).every(([k, v]) => r[k] === v));
    },
    // spec/01 pageX：模拟宿主 queryWithCount 信封（含分页切片与 total/hasMore）
    async queryWithCount(gql, params) {
      gqlLog.push({ gql, params });
      const cond = params && params.c0;
      const matched = rows.filter(
        (r) => !cond || Object.entries(cond).every(([k, v]) => r[k] === v)
      );
      const page = params && params.page != null ? params.page : 0;
      const pageSize = params && params.pageSize != null ? params.pageSize : 50;
      const start = page * pageSize;
      return {
        items: matched.slice(start, start + pageSize),
        total: matched.length,
        hasMore: (page + 1) * pageSize < matched.length,
        page,
        pageSize,
      };
    },
    async insert(_name, data) {
      const doc = { _id: idOf(rows), ...data };
      rows.push(doc);
      return doc;
    },
    // remove 先于 update 声明（无依赖方法，顺序无关语义）
    async remove(_name, cond) {
      const i = rows.findIndex((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      if (i >= 0) rows.splice(i, 1);
    },
    async update(_name, cond, data) {
      const row = rows.find((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      Object.assign(row, data);
      return row;
    },
    setContext() {},
  };
}

/** 执行 GraphQL query 并返回 data；执行错误聚合为单条 Error 上抛 */
async function runQuery(schema, query, variableValues) {
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

/** smoke 测试共用的 User schema 定义（GraphQL 投影/隐藏/只读矩阵的基准模型） */
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

// 内存版 store：query 按「模型+条件」匹配，记录 GQL 串供断言投影下推（共用辅助工厂）
function makeMockStore() {
  return makeGqlMockStore({
    names: ['User'],
    schemaDefn: DEFN,
    idOf: (rows) => `u${rows.length + 1}`,
  });
}

// ── spec/04：HTTP 承载（graphqlPlugin，Fastify 插件）──

async function makeApp(opts) {
  const app = require('fastify')({ logger: false });
  await app.register(require('../../src/index').graphqlPlugin, opts);
  await app.ready();
  return app;
}

const gqlPost = (url, query) => ({
  method: 'POST',
  url,
  headers: { 'content-type': 'application/json' },
  payload: { query },
});

module.exports = { makeGqlMockStore, runQuery, DEFN, makeMockStore, makeApp, gqlPost };
