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
 */

const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  Kind,
  printSchema,
} = require('graphql');

const ARCHIVE_SUFFIX = 'Deleted';

// ── spec/01：归档表过滤（与 store-api 三端逐字一致）──
function filterArchived(names) {
  const set = new Set(names);
  return names.filter(
    (n) => !(n.endsWith(ARCHIVE_SUFFIX) && set.has(n.slice(0, -ARCHIVE_SUFFIX.length)))
  );
}

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

function modelFields(defn) {
  // fields + computes 视同字段进入类型（spec/01）
  return { ...(defn.fields || {}), ...(defn.computes || {}) };
}

// ── spec/02：selection → GQL 投影串（fragments 展开 + @skip/@include 求值 + 空投影回退）──
function shouldInclude(node, vars) {
  for (const d of node.directives || []) {
    if (d.name.value !== 'skip' && d.name.value !== 'include') continue;
    const ifArg = (d.arguments || []).find((a) => a.name.value === 'if');
    if (!ifArg) continue;
    let val;
    if (ifArg.value.kind === Kind.VARIABLE) val = vars ? vars[ifArg.value.name.value] : undefined;
    else if (ifArg.value.kind === Kind.BOOLEAN) val = ifArg.value.value;
    else continue;
    if (val === undefined) continue;
    if (d.name.value === 'skip' && val) return false;
    if (d.name.value === 'include' && !val) return false;
  }
  return true;
}

function projectionFromResolveInfo(info) {
  const root = info.fieldNodes.find((n) => n.kind === Kind.FIELD) || info.fieldNodes[0];
  const vars = info.variableValues || {};
  const walk = (sel) => {
    if (sel.kind === Kind.FIELD) {
      if (!shouldInclude(sel, vars)) return null;
      const head = sel.name.value; // alias v0 忽略（spec/02）
      const sub = sel.selectionSet
        ? ` { ${sel.selectionSet.selections.map(walk).filter(Boolean).join(', ')} }`
        : '';
      return head + sub;
    }
    if (sel.kind === Kind.INLINE_FRAGMENT) {
      return sel.selectionSet.selections.map(walk).filter(Boolean).join(', ');
    }
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const frag = info.fragments && info.fragments[sel.name.value];
      return frag ? frag.selectionSet.selections.map(walk).filter(Boolean).join(', ') : null;
    }
    return null;
  };
  const parts = root.selectionSet.selections.map(walk).filter(Boolean).join(', ');
  return parts || '_id'; // spec/02：空投影回退，保证 GQL 串合法
}

// ── spec/02：根 resolver（投影下推，无 N+1）──
function makeGet(store, name, idField) {
  return async (_src, args, _ctx, info) => {
    const projection = projectionFromResolveInfo(info);
    const rows = await store.query(`${name}($condition:@c0) { ${projection} }`, {
      c0: { [idField]: args.id },
    });
    return rows && rows[0] ? rows[0] : null;
  };
}

function makeList(store, name) {
  return async (_src, args, _ctx, info) => {
    const projection = projectionFromResolveInfo(info);
    let head = name;
    const parts = [];
    const params = {};
    if (args.condition != null) { parts.push('$condition:@c0'); params.c0 = args.condition; }
    if (args.sort != null) { parts.push('$sort:@s1'); params.s1 = args.sort; }
    if (args.limit != null) { parts.push('$limit:@l'); params.l = args.limit; }
    if (parts.length) head += `(${parts.join(',')})`;
    return store.query(`${head} { ${projection} }`, params);
  };
}

function makeCreate(store, name) {
  return async (_src, args) => store.insert(name, args.input);
}

function makeUpdate(store, name, idField) {
  return async (_src, args, _ctx, info) => {
    await store.update(name, { [idField]: args.id }, args.set);
    const projection = projectionFromResolveInfo(info);
    const rows = await store.query(`${name}($condition:@c0) { ${projection} }`, {
      c0: { [idField]: args.id },
    });
    return rows && rows[0] ? rows[0] : null;
  };
}

function makeDelete(store, name, idField) {
  return async (_src, args) => {
    await store.remove(name, { [idField]: args.id });
    return true;
  };
}

// ── schema 构建 ──
function buildGraphQLSchema(store, opts = {}) {
  const idField = opts.idField || '_id';
  const overrides = opts.overrides || {};
  const extensions = opts.extensions || {};

  const names = opts.resources || filterArchived(store.list());
  const queryFields = {};
  const mutationFields = {};
  const usedOverrideKeys = new Set();

  const resolveWithOverride = (key, fallback) => {
    const fn = overrides[key];
    if (fn) usedOverrideKeys.add(key);
    return fn || fallback;
  };

  for (const name of names) {
    const defn = store.get(name);
    const xg = defn['x-graphql'] || {};
    if (xg.hidden) continue; // spec/03 钩子 1：模型级 hidden
    const modelType = new GraphQLObjectType({
      name,
      description: defn.description, // spec/05
      fields: () => mapFields(modelFields(defn), name),
    });
    queryFields[`get_${name}`] = {
      type: modelType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: resolveWithOverride(`Query.get_${name}`, makeGet(store, name, idField)),
    };
    queryFields[`list_${name}`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(modelType))),
      args: {
        condition: { type: GraphQLJSON },
        sort: { type: GraphQLJSON },
        limit: { type: GraphQLInt },
      },
      resolve: resolveWithOverride(`Query.list_${name}`, makeList(store, name)),
    };
    if (!xg.readonly) { // spec/03 钩子 1：模型级 readonly → 只出 Query
      mutationFields[`create_${name}`] = {
        type: modelType,
        args: { input: { type: new GraphQLNonNull(GraphQLJSON) } },
        resolve: resolveWithOverride(`Mutation.create_${name}`, makeCreate(store, name)),
      };
      mutationFields[`update_${name}`] = {
        type: modelType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          set: { type: new GraphQLNonNull(GraphQLJSON) },
        },
        resolve: resolveWithOverride(`Mutation.update_${name}`, makeUpdate(store, name, idField)),
      };
      mutationFields[`delete_${name}`] = {
        type: new GraphQLNonNull(GraphQLBoolean),
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: resolveWithOverride(`Mutation.delete_${name}`, makeDelete(store, name, idField)),
      };
    }
  }

  // spec/03 钩子 3：extend（SDL 同步追加）
  for (const [key, fields] of Object.entries(extensions)) {
    if (key === 'Query') Object.assign(queryFields, fields);
    else if (key === 'Mutation') Object.assign(mutationFields, fields);
    else throw new Error(`extensions 仅支持 Query/Mutation，收到 "${key}"（spec/03）`);
  }

  // spec/03：override 键构建期校验，未知路径报错不静默
  for (const key of Object.keys(overrides)) {
    if (!usedOverrideKeys.has(key)) {
      throw new Error(`override 路径 "${key}" 未命中任何生成字段（spec/03）`);
    }
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: () => queryFields }),
    mutation: Object.keys(mutationFields).length
      ? new GraphQLObjectType({ name: 'Mutation', fields: () => mutationFields })
      : undefined,
  });
}

// ── spec/01：SDL 导出（喂客户端 codegen）──
function exportSDL(schema) {
  return printSchema(schema);
}

// ── spec/04：HTTP 承载（GraphQL Yoga，可选依赖）──

// isPermissionError 按 core 稳定前缀判定（ERR_PERM_PREFIX 契约，同 store-api 三端，禁按文案匹配）
function isPermissionError(e) {
  return String((e && e.message) || e).startsWith('ERR_PERMISSION:');
}

function createYoga(store, opts = {}) {
  let yogaMod;
  try {
    // eslint-disable-next-line global-require
    yogaMod = require('graphql-yoga');
  } catch (e) {
    throw new Error('使用 createYoga 需要安装 graphql-yoga（npm i graphql-yoga）；或仅用 buildGraphQLSchema 自行承载');
  }
  const { createYoga: createYogaImpl } = yogaMod;
  const schema = opts.schema || buildGraphQLSchema(store, opts);
  const yoga = createYogaImpl({
    schema,
    logging: opts.logging != null ? opts.logging : false,
    // spec/04：上下文在包装层注入（Yoga 的 context factory 无法自定义 HTTP 状态码）
    context: undefined,
  });
  // 包装层：每请求先跑 contextFactory 并按 spec/04 分类（403/401），再进 Yoga 执行
  const handler = async (req, serverCtx) => {
    if (opts.contextFactory) {
      try {
        // spec/04：每请求注入；返回 null 同样显式 setContext（清除语义必须落地）
        const ctx = await opts.contextFactory({ request: req, serverContext: serverCtx });
        store.setContext(ctx != null ? ctx : null);
      } catch (e) {
        const status = isPermissionError(e) ? 403 : 401;
        return new Response(
          JSON.stringify({ errors: [{ message: String((e && e.message) || e) }] }),
          { status, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
    return yoga(req, serverCtx);
  };
  return { yoga: handler, schema };
}

module.exports = {
  filterArchived,
  GraphQLJSON,
  buildGraphQLSchema,
  exportSDL,
  createYoga,
};
