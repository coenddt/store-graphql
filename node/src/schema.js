'use strict';

/**
 * schema 装配（D4-4 零语义拆分自 index.js）。
 *
 * 单模型字段生成、扩展合并、override 构建期校验、最终 schema 组装与 SDL 导出。
 */

const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
  GraphQLInt,
  GraphQLBoolean,
  printSchema,
} = require('graphql');

const { filterArchived, filterReserved } = require('./names');
const { GraphQLJSON, mapFields, modelFields } = require('./types');
const {
  makeGet,
  makeList,
  makeCreate,
  makeUpdate,
  makeDelete,
} = require('./resolvers');

// ── schema 构建 ──
/** 单模型的 Query 字段（get / list）与 Mutation 字段（create / update / delete） */
function buildModelFields(ctx, name, defn) {
  const { store, idField, resolveWithOverride, queryFields, mutationFields } = ctx;
  const modelType = new GraphQLObjectType({
    name,
    description: defn.description, // spec/05
    fields: () => mapFields(modelFields(defn), name),
  });
  queryFields[`get${name}`] = {
    type: modelType,
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: resolveWithOverride(`Query.get${name}`, makeGet(store, name, idField)),
  };
  queryFields[`list${name}`] = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(modelType))),
    args: {
      condition: { type: GraphQLJSON },
      sort: { type: GraphQLJSON },
      limit: { type: GraphQLInt },
    },
    resolve: resolveWithOverride(`Query.list${name}`, makeList(store, name)),
  };
  if ((defn['x-graphql'] || {}).readonly) return; // spec/03 钩子 1：模型级 readonly → 只出 Query
  mutationFields[`create${name}`] = {
    type: modelType,
    args: { input: { type: new GraphQLNonNull(GraphQLJSON) } },
    resolve: resolveWithOverride(`Mutation.create${name}`, makeCreate(store, name)),
  };
  mutationFields[`update${name}`] = {
    type: modelType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      set: { type: new GraphQLNonNull(GraphQLJSON) },
    },
    resolve: resolveWithOverride(`Mutation.update${name}`, makeUpdate(store, name, idField)),
  };
  mutationFields[`delete${name}`] = {
    type: new GraphQLNonNull(GraphQLBoolean),
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: resolveWithOverride(`Mutation.delete${name}`, makeDelete(store, name, idField)),
  };
}

/** 遍历模型清单：hidden 跳过（spec/03 钩子 1：模型级 hidden） */
function addModelFields(ctx, names) {
  for (const name of names) {
    const defn = ctx.store.get(name);
    if ((defn['x-graphql'] || {}).hidden) continue;
    buildModelFields(ctx, name, defn);
  }
}

/** spec/03 钩子 3：extend（SDL 同步追加），仅支持 Query/Mutation */
function mergeExtensions(queryFields, mutationFields, extensions) {
  for (const [key, fields] of Object.entries(extensions)) {
    if (key === 'Query') Object.assign(queryFields, fields);
    else if (key === 'Mutation') Object.assign(mutationFields, fields);
    else throw new Error(`extensions 仅支持 Query/Mutation，收到 "${key}"（spec/03）`);
  }
}

/** spec/03：override 键构建期校验，未知路径报错不静默 */
function assertOverridesUsed(overrides, usedOverrideKeys) {
  for (const key of Object.keys(overrides)) {
    if (!usedOverrideKeys.has(key)) {
      throw new Error(`override 路径 "${key}" 未命中任何生成字段（spec/03）`);
    }
  }
}

/** 组装最终 schema：无 Mutation 时不建 Mutation 类型 */
function schemaOf(queryFields, mutationFields) {
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: () => queryFields }),
    mutation: Object.keys(mutationFields).length
      ? new GraphQLObjectType({ name: 'Mutation', fields: () => mutationFields })
      : undefined,
  });
}

/** 由 store 的模型清单构建完整 GraphQLSchema（含归档 / 保留名过滤与 override 校验） */
function buildGraphQLSchema(store, opts = {}) {
  const idField = opts.idField || '_id';
  const overrides = opts.overrides || {};
  const extensions = opts.extensions || {};

  // spec/01：默认过滤归档表；`includeArchived: true` 为显式开关（点名要看归档的人能拿到）。
  // `__` 保留名过滤不受该开关影响。
  const rawNames = opts.resources ?? store.list();
  const names = filterReserved(opts.includeArchived ? rawNames : filterArchived(rawNames));
  const queryFields = {};
  const mutationFields = {};
  const usedOverrideKeys = new Set();

  /** 取 override 解析器（命中即登记用于构建期校验）；缺省回落内置 resolver */
  const resolveWithOverride = (key, fallback) => {
    const fn = overrides[key];
    if (fn) usedOverrideKeys.add(key);
    return fn || fallback;
  };

  addModelFields({ store, idField, resolveWithOverride, queryFields, mutationFields }, names);
  mergeExtensions(queryFields, mutationFields, extensions); // spec/03 钩子 3：extend（SDL 同步追加）
  assertOverridesUsed(overrides, usedOverrideKeys);          // spec/03：override 键构建期校验
  return schemaOf(queryFields, mutationFields);
}

// ── spec/01：SDL 导出（喂客户端 codegen）──
/** 导出 SDL 文本（喂客户端 codegen） */
function exportSDL(schema) {
  return printSchema(schema);
}

module.exports = {
  buildModelFields,
  addModelFields,
  mergeExtensions,
  assertOverridesUsed,
  schemaOf,
  buildGraphQLSchema,
  exportSDL,
};
