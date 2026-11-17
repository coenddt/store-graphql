'use strict';

/**
 * store-graphql-node — 为 nodejs-store 已注册 schema 自动生成标准 GraphQL API。
 *
 * 语义依据：../spec/*.md（多端 parity，改动先改 spec）。
 * 设计哲学：GraphQL 只是 GQL 的又一层 HTTP 皮 —— 适配层零语义发明。
 *
 * 分层：
 *   buildGraphQLSchema(store, opts) → 纯 graphql-js GraphQLSchema（执行器无关）
 *   createYoga(store, opts)         → GraphQL Yoga 实例（HTTP 承载，可挂任意框架或独立跑）
 *   exportSDL(schema)               → SDL 字符串（喂客户端 codegen）
 *
 * store 端口契约见 spec/00：list/get/query/insert/update/remove/setContext。
 *
 * D4-4 零语义拆分：查询守卫下沉 ./guards.js、模型名过滤下沉 ./names.js、
 * 类型映射下沉 ./types.js、投影下推下沉 ./projection.js、根 resolver 下沉 ./resolvers.js、
 * schema 装配下沉 ./schema.js、错误掩码下沉 ./error-mask.js、Yoga 承载下沉 ./yoga.js、
 * Fastify 插件下沉 ./http.js。本文件只做门面 re-export，导出面键名 / 键序逐字不变。
 */

const { filterArchived } = require('./names');
const { GraphQLJSON } = require('./types');
const { buildGraphQLSchema, exportSDL } = require('./schema');
const { createYoga } = require('./yoga');
const { graphqlPlugin } = require('./http');
const { queryDepthOf, queryFieldCount } = require('./guards');

module.exports = {
  filterArchived,
  GraphQLJSON,
  buildGraphQLSchema,
  exportSDL,
  createYoga,
  graphqlPlugin,
  queryDepthOf,
  queryFieldCount,
};
