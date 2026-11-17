'use strict';

/**
 * spec/01 defn 字段 → GraphQL 类型映射（D4-4 零语义拆分自 index.js）。
 *
 * JSON 标量、标量表、嵌套对象类型与模型字段集组装；零 schema 装配。
 */

const {
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLNonNull,
  GraphQLID,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
} = require('graphql');

// ── spec/01：JSON 标量（承接 condition/sort/input 的动态 JSON；只接受 variables）──
const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: '任意 JSON 值（条件/排序/写入文档）。只接受 variables 形式（spec/02）。',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral() {
    throw new Error('JSON 标量只接受 variables 传入（spec/02）');
  },
});

// ── spec/01：defn 字段类型 → GraphQL 输出类型 ──
/** defn 字段类型 → GraphQL 标量；未知类型返回 null（调用侧回落 JSON） */
function scalarFor(typeName) {
  switch (typeName) {
    case 'string':
    case 'datetime':
      return GraphQLString;
    case 'int':
      return GraphQLInt;
    case 'float':
      return GraphQLFloat;
    case 'bool':
      return GraphQLBoolean;
    default:
      return null;
  }
}

/** 字段定义 → GraphQL 输出类型：object 建嵌套对象类型，其余走标量 / JSON */
function outType(fieldDefn, typeName) {
  if (fieldDefn.type === 'object' && fieldDefn.fields) {
    return new GraphQLObjectType({
      name: typeName,
      description: fieldDefn.description, // spec/05：description 透传不改写
      fields: () => mapFields(fieldDefn.fields, typeName),
    });
  }
  return scalarFor(fieldDefn.type) || GraphQLJSON;
}

/**
 * 模型字段定义 → graphql 字段映射表
 * @param {any} fields 模型的 fields / computes
 * @param {string} typeName 所属 GraphQL 类型名（嵌套字段命名前缀）
 * @returns {Record<string, any>} 字段名 → GraphQLFieldConfig
 */
function mapFields(fields, typeName) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = {
      type: k === '_id' ? new GraphQLNonNull(GraphQLID) : outType(v, `${typeName}_${k}`),
      description: v.description, // spec/05：含 computes 与嵌套字段
    };
  }
  return out;
}

/** 模型对外字段集：fields + computes + 恒注入的 _score（向量得分） */
function modelFields(defn) {
  // fields + computes 视同字段进入类型（spec/01）
  // `_score`：向量检索派生列（04），恒注入且可空 —— 未请求时 core 不产出该键
  return {
    ...(defn.fields || {}),
    ...(defn.computes || {}),
    _score: { type: 'float', description: '向量检索相似度得分（越大越相似）' },
  };
}

module.exports = { GraphQLJSON, scalarFor, outType, mapFields, modelFields };
