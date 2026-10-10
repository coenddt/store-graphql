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
  GraphQLError,
  Kind,
  parse,
  printSchema,
} = require('graphql');

const ARCHIVE_SUFFIX = 'Deleted';

// ── spec/04 查询深度守卫 ──
const MAX_QUERY_DEPTH = 10;

// ── spec/04 复杂度守卫:AST 字段节点总数(别名不单列——字段计数已覆盖别名堆叠)──
const MAX_QUERY_FIELDS = 300;

// 字段计数 + introspection 使用检测(fragment 展开计入,visiting 防环;__typename 放行)
function queryFieldCount(document) {
  const fragments = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  let count = 0;
  let introspectionUsed = false;
  const walkSelSet = (selSet, visiting) => {
    if (!selSet) return;
    for (const sel of selSet.selections) {
      if (sel.kind === Kind.FIELD) {
        count += 1;
        const name = sel.name.value;
        if (!introspectionUsed && (name === '__schema' || name === '__type')) {
          introspectionUsed = true;
        }
        walkSelSet(sel.selectionSet, visiting);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        walkSelSet(sel.selectionSet, visiting);
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const name = sel.name.value;
        if (!visiting.has(name)) {
          const frag = fragments[name];
          if (frag) walkSelSet(frag.selectionSet, new Set([...visiting, name]));
        }
      }
    }
  };
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) walkSelSet(def.selectionSet, new Set());
  }
  return { fields: count, introspectionUsed };
}

// 深度 = 从 operation 顶层 selectionSet 起的最大字段嵌套层数;FragmentSpread 按定义
// 递归(visiting 防环),InlineFragment 原地展开;取所有 operation 的最大值。
function queryDepthOf(document) {
  const fragments = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  const depthOfSelSet = (selSet, visiting) => {
    if (!selSet) return 0;
    let max = 0;
    for (const sel of selSet.selections) {
      let d = 0;
      if (sel.kind === Kind.FIELD) {
        d = 1 + depthOfSelSet(sel.selectionSet, visiting);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        d = depthOfSelSet(sel.selectionSet, visiting);
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const name = sel.name.value;
        if (!visiting.has(name)) {
          const frag = fragments[name];
          d = frag ? depthOfSelSet(frag.selectionSet, new Set([...visiting, name])) : 0;
        }
      }
      if (d > max) max = d;
    }
    return max;
  };
  let max = 0;
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      const d = depthOfSelSet(def.selectionSet, new Set());
      if (d > max) max = d;
    }
  }
  return max;
}

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

// spec/02 limit 守卫常量：core 的行数封顶仅 text2query 档生效（standard 档原样返回），
// 适配层守上界；调整先改 spec 再三端同步。
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 1000;

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
    // spec/02 limit 守卫：缺省 50 防全表；超上限抛错（ERR_LIMIT: 稳定前缀），不静默截断
    const limit = args.limit != null ? args.limit : LIST_LIMIT_DEFAULT;
    if (limit > LIST_LIMIT_MAX) {
      throw new Error(`ERR_LIMIT:list limit 上限 ${LIST_LIMIT_MAX},收到 ${limit}`);
    }
    const projection = projectionFromResolveInfo(info);
    let head = name;
    const parts = [];
    const params = {};
    if (args.condition != null) { parts.push('$condition:@c0'); params.c0 = args.condition; }
    if (args.sort != null) { parts.push('$sort:@s1'); params.s1 = args.sort; }
    parts.push('$limit:@l');
    params.l = limit;
    head += `(${parts.join(',')})`;
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

// isNoContextError 判定权限类同档的 NoContext（requireContext 开启且 ctx 缺失）：
// 宿主（nodejs-store）抛 NoContextError 带 machine code `no_context`（已剥前缀）；字符串
// 通道 host 保留 `ERR_NO_CONTEXT:` 前缀。按类型/码判定，禁按文案匹配 → 与权限类同 ⇒ 403。
function isNoContextError(e) {
  if (!e) return false;
  if (e.code === 'no_context' || e.name === 'NoContextError') return true;
  return String((e && e.message) || e).startsWith('ERR_NO_CONTEXT:');
}

// 权限类（含同档 NoContext）统一判定
function isPermissionClass(e) {
  return isPermissionError(e) || isNoContextError(e);
}

// spec/04：错误呈现默认——非权限错误原样透出（parity py/go，符合本 spec「原样透传」）；
// 权限类错误附加 HTTP 403 + code FORBIDDEN，message 原样（剥前缀属展示层，走 opts.maskError）
function defaultMaskError(error, message, isDev) {
  const orig = (error && error.originalError) || error;
  if (!isPermissionClass(error) && !isPermissionClass(orig)) return error;
  return new GraphQLError(String((error && error.message) || ''), {
    nodes: error && error.nodes,
    path: error && error.path,
    originalError: orig,
    extensions: {
      ...((error && error.extensions) || {}),
      code: 'FORBIDDEN',
      http: { status: 403 },
    },
  });
}

function createYoga(store, opts = {}) {
  // fail-secure 装配守卫：宿主开启上下文强制却未配 contextFactory 时，装配期即拒绝
  // （fail-fast）；否则每请求在运行期以 ERR_NO_CONTEXT 失败（no-error-masking）。
  if (typeof store.requireContext === 'function' && store.requireContext() && !opts.contextFactory) {
    throw new Error(
      'ERR_SECURE_CONFIG: 宿主已开启上下文强制（fail-secure）但未配置 opts.contextFactory；'
      + '请注入从请求解析身份的 contextFactory（spec/04），'
      + '无需鉴权的内部服务请显式 store.setRequireContext(false) 后再装配',
    );
  }
  let yogaMod;
  try {
    // eslint-disable-next-line global-require
    yogaMod = require('graphql-yoga');
  } catch (e) {
    throw new Error('使用 createYoga 需要安装 graphql-yoga（npm i graphql-yoga）；或仅用 buildGraphQLSchema 自行承载');
  }
  const { createYoga: createYogaImpl } = yogaMod;
  const schema = opts.schema || buildGraphQLSchema(store, opts);
  const depthLimit = opts.maxQueryDepth != null ? opts.maxQueryDepth : MAX_QUERY_DEPTH;
  const fieldsLimit = opts.maxQueryFields != null ? opts.maxQueryFields : MAX_QUERY_FIELDS;
  const introspectionEnabled = opts.introspection !== false;
  const yoga = createYogaImpl({
    schema,
    logging: opts.logging != null ? opts.logging : false,
    // spec/04：请求体上限 1MB(Yoga 默认 25MB,显式收窄对齐 store-api 三端)
    maxRequestBodySize: 1 << 20,
    // spec/04：默认自定义掩码（原样透出 + 权限错误 403）；maskedErrors 直通 Yoga，maskError 单独覆盖
    // （Yoga v5 只认对象形态，传裸函数会被静默忽略退回默认掩码）
    maskedErrors: opts.maskedErrors !== undefined
      ? opts.maskedErrors
      : { maskError: opts.maskError || defaultMaskError },
    // spec/04:深度/复杂度/introspection 守卫(onExecute 期拦截,extensions.http.status 定 400)
    plugins: [
      {
        onExecute({ args }) {
          const d = queryDepthOf(args.document);
          if (d > depthLimit) {
            throw new GraphQLError(`ERR_DEPTH:查询深度 ${d} 超过上限 ${depthLimit}`, {
              extensions: { code: 'ERR_DEPTH', http: { status: 400 } },
            });
          }
          const { fields, introspectionUsed } = queryFieldCount(args.document);
          if (introspectionUsed && !introspectionEnabled) {
            throw new GraphQLError('ERR_INTROSPECTION:introspection 已禁用', {
              extensions: { code: 'ERR_INTROSPECTION', http: { status: 400 } },
            });
          }
          if (fields > fieldsLimit) {
            throw new GraphQLError(`ERR_COMPLEXITY:查询字段数 ${fields} 超过上限 ${fieldsLimit}`, {
              extensions: { code: 'ERR_COMPLEXITY', http: { status: 400 } },
            });
          }
        },
      },
    ],
    // spec/04：context 在包装层注入（Yoga 的 context factory 无法自定义 HTTP 状态码）
    context: undefined,
    // 承载端点（Yoga 原生选项 graphqlEndpoint；缺省 /graphql。store-gateway 组合时透传自定义路径）
    ...(opts.endpoint ? { graphqlEndpoint: opts.endpoint } : {}),
  });
  // 包装层：每请求先跑 contextFactory 并按 spec/04 分类（403/401），再进 Yoga 执行
  const handler = async (req, serverCtx) => {
    if (opts.contextFactory) {
      try {
        // spec/04：每请求注入；同步 contextFactory 走快路径——不引入 await 微任务，
        // 避免 AsyncLocalStorage.enterWith 在微任务里落地致上下文传不到 resolver（返回 null 同样显式落地清除）
        const maybe = opts.contextFactory({ request: req, serverContext: serverCtx });
        const ctx = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
        store.setContext(ctx != null ? ctx : null);
      } catch (e) {
        const status = isPermissionClass(e) ? 403 : 401;
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

// ── spec/04：HTTP 承载（Fastify 插件；宿主与 store-gateway 的统一入口）──
// 默认 path '/graphql'；opts 透传 createYoga（contextFactory / 守卫阈值 / maskError / schema / resources / idField ...）
// 回拷响应头剔除长度/编码类：body 已经 res.text() 解码，原 content-length / content-encoding 与实际不符
const SKIP_RES_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

async function graphqlPlugin(fastify, opts = {}) {
  const { store, path: gqlPath = '/graphql', ...yogaOpts } = opts;
  if (!store) throw new Error('ERR_NO_STORE:graphqlPlugin 需要 store（spec/00 store 端口契约）');
  const { yoga } = createYoga(store, { endpoint: gqlPath, ...yogaOpts });
  fastify.route({
    method: ['GET', 'POST'],
    url: gqlPath,
    handler: async (req, reply) => {
      const url = `http://${req.headers.host || 'localhost'}${req.raw.url}`;
      const init = { method: req.method, headers: req.headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = JSON.stringify(req.body ?? {});
      const res = await yoga(new Request(url, init));
      reply.code(res.status);
      for (const [k, v] of res.headers) {
        const key = k.toLowerCase();
        if (SKIP_RES_HEADERS.has(key) || key === 'set-cookie') continue;
        reply.header(k, v);
      }
      // set-cookie 多值须逐条 append（iterator 返回合并串，Cookie 的 Expires 含逗号会被解析坏）
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        reply.header('set-cookie', c);
      }
      return reply.send(await res.text());
    },
  });
}

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
