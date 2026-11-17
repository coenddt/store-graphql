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
  printSchema,
} = require('graphql');

const ARCHIVE_SUFFIX = 'Deleted';

// ── spec/04 查询深度守卫 ──
const MAX_QUERY_DEPTH = 10;

// ── spec/04 复杂度守卫:AST 字段节点总数(别名不单列——字段计数已覆盖别名堆叠)──
const MAX_QUERY_FIELDS = 300;

// introspection 根字段（__schema / __type）：出现即判定为「用了 introspection」
/** introspection 根字段判定（__schema / __type） */
function isIntrospectionName(name) {
  return name === '__schema' || name === '__type';
}

// 字段计数 + introspection 使用检测(fragment 展开计入,visiting 防环;__typename 放行)
/** 统计 AST 字段节点总数并检测是否使用 introspection（fragment 展开、防环） */
function queryFieldCount(document) {
  const fragments = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  let count = 0;
  let introspectionUsed = false;
  /** 递归遍历 selectionSet 计数（visiting 防 fragment 环；InlineFragment 原地展开） */
  const walkSelSet = (selSet, visiting) => {
    if (!selSet) return;
    for (const sel of selSet.selections) {
      if (sel.kind === Kind.FIELD) {
        count += 1;
        const name = sel.name.value;
        if (!introspectionUsed && isIntrospectionName(name)) {
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
/** 计算所有 operation 的最大字段嵌套深度（fragment 展开、防环） */
function queryDepthOf(document) {
  const fragments = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  /** 递归求 selectionSet 的最大深度（FIELD 计 1 层，InlineFragment 不增层） */
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
/** 归档表过滤：剔除「有同名存续表」的 <名>Deleted（spec/01，三端逐字一致） */
function filterArchived(names) {
  const set = new Set(names);
  return names.filter(
    (n) => !(n.endsWith(ARCHIVE_SUFFIX) && set.has(n.slice(0, -ARCHIVE_SUFFIX.length)))
  );
}

// ── GraphQL 规范：`__` 前缀为 introspection 保留，不得作为类型名 ──
// core 注册的控制面内建模型（__workflowRun / __schemaDef / __workflowDef / __feedback）
// 一旦进 schema，assertValidSchema 判「Name "__x" must not begin with "__"」→ 全 schema 失效。
// 该过滤为 GraphQL 皮专有约束（REST/gRPC/MCP 无此限制），故不并入与 store-api 逐字一致的
// filterArchived；按 GraphQL 规范无条件生效（含显式 resources 入参）。
/** 剔除 `__` 前缀保留名（GraphQL 规范：不得作为类型名） */
function filterReserved(names) {
  return names.filter((n) => !n.startsWith('__'));
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

// ── spec/02：selection → GQL 投影串（fragments 展开 + @skip/@include 求值 + 空投影回退）──

/** 是否为条件指令（@skip / @include） */
function isConditionalDirective(d) {
  const name = d.name.value;
  return name === 'skip' || name === 'include';
}

/** 取条件指令的 if 实参求值；不可求值（缺参 / 非 variable|boolean / 变量未给）→ undefined */
function directiveIfValue(d, vars) {
  const ifArg = (d.arguments || []).find((a) => a.name.value === 'if');
  if (!ifArg) return undefined;
  if (ifArg.value.kind === Kind.VARIABLE) return vars ? vars[ifArg.value.name.value] : undefined;
  if (ifArg.value.kind === Kind.BOOLEAN) return ifArg.value.value;
  return undefined;
}

/** @skip / @include 求值：任一条件不满足即排除该字段 */
function shouldInclude(node, vars) {
  for (const d of node.directives || []) {
    if (!isConditionalDirective(d)) continue;
    const val = directiveIfValue(d, vars);
    if (val === undefined) continue;
    if (d.name.value === 'skip' && val) return false;
    if (d.name.value === 'include' && !val) return false;
  }
  return true;
}

/** resolveInfo → GQL 投影串（fragments 展开、指令求值、空投影回退 _id） */
function projectionFromResolveInfo(info) {
  const root = info.fieldNodes.find((n) => n.kind === Kind.FIELD) || info.fieldNodes[0];
  const vars = info.variableValues || {};
  /** 单节点投影拼装：FIELD 拼「名 { 子投影 }」，fragment 原地展开 */
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

/** 按 id 回查单行并取首行（get / update 回读共用）；查不到返回 null */
async function queryByIdRow(store, name, idField, id, projection) {
  const rows = await store.query(`${name}($condition:@c0) { ${projection} }`, {
    c0: { [idField]: id },
  });
  return rows && rows[0] ? rows[0] : null;
}

/** 生成单行查询 resolver（按 id 回查，投影下推） */
function makeGet(store, name, idField) {
  return async (_src, args, _ctx, info) => {
    const projection = projectionFromResolveInfo(info);
    return queryByIdRow(store, name, idField, args.id, projection);
  };
}

// ── 04：`$near` 与根 `$limit` 互斥（spec/02）──

/** 深度优先找第一个同名键（`$near` 只允许出现一次，由 core 保证） */
function findByKey(node, key) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findByKey(v, key);
      if (hit) return hit;
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const v of Object.values(node)) {
    const hit = findByKey(v, key);
    if (hit) return hit;
  }
  return null;
}

/**
 * 校验并返回是否含 `$near`。
 * 契约：含 `$near` → 不拼根 `$limit`；显式 limit 与 `$near` 并用 → ERR_LIMIT；
 *       `$near.$limit` 上界在这里守，必填交给 core（避免两处文案漂移）。
 */
function vectorLimitGuard(condition, explicitLimit) {
  const near = findByKey(condition, '$near');
  if (!near) return false;
  if (explicitLimit != null) {
    throw new Error('ERR_LIMIT:list limit 与 $near.$limit 互斥，请只传 $near.$limit');
  }
  const n = near.$limit;
  if (n != null && n > LIST_LIMIT_MAX) {
    throw new Error(`ERR_LIMIT:$near.$limit 上限 ${LIST_LIMIT_MAX},收到 ${n}`);
  }
  return true;
}

/** 生成列表 resolver（条件 / 排序 / limit 守卫 + 投影下推） */
function makeList(store, name) {
  return async (_src, args, _ctx, info) => {
    // 04：先判 `$near`，再走 limit 守卫（顺序不可颠倒：互斥文案优先于上界文案）
    const hasNear = vectorLimitGuard(args.condition, args.limit);
    // spec/02 limit 守卫：缺省 50 防全表；超上限抛错（ERR_LIMIT: 稳定前缀），不静默截断
    const limit = args.limit != null ? args.limit : LIST_LIMIT_DEFAULT;
    if (!hasNear && limit > LIST_LIMIT_MAX) {
      throw new Error(`ERR_LIMIT:list limit 上限 ${LIST_LIMIT_MAX},收到 ${limit}`);
    }
    const projection = projectionFromResolveInfo(info);
    let head = name;
    const parts = [];
    const params = {};
    if (args.condition != null) { parts.push('$condition:@c0'); params.c0 = args.condition; }
    if (args.sort != null) { parts.push('$sort:@s1'); params.s1 = args.sort; }
    if (!hasNear) {                       // 04：向量查询的条数唯一来源是 $near.$limit
      parts.push('$limit:@l');
      params.l = limit;
    }
    head += `(${parts.join(',')})`;
    return store.query(`${head} { ${projection} }`, params);
  };
}

/** 生成插入 resolver（原样透传 input 给 store.insert） */
function makeCreate(store, name) {
  return async (_src, args) => store.insert(name, args.input);
}

/** 生成更新 resolver（update 后按投影回读最新行） */
function makeUpdate(store, name, idField) {
  return async (_src, args, _ctx, info) => {
    await store.update(name, { [idField]: args.id }, args.set);
    const projection = projectionFromResolveInfo(info);
    return queryByIdRow(store, name, idField, args.id, projection);
  };
}

/** 生成删除 resolver（store.remove，恒返回 true） */
function makeDelete(store, name, idField) {
  return async (_src, args) => {
    await store.remove(name, { [idField]: args.id });
    return true;
  };
}

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

// ── spec/04：HTTP 承载（GraphQL Yoga，可选依赖）──

// isPermissionError 按 core 稳定前缀判定（ERR_PERM_PREFIX 契约，同 store-api 三端，禁按文案匹配）
/** 权限错误判定：按 ERR_PERMISSION: 稳定前缀，禁按文案匹配 */
function isPermissionError(e) {
  return String((e && e.message) || e).startsWith('ERR_PERMISSION:');
}

// isNoContextError 判定权限类同档的 NoContext（requireContext 开启且 ctx 缺失）：
// 宿主（nodejs-store）抛 NoContextError 带 machine code `no_context`（已剥前缀）；字符串
// 通道 host 保留 `ERR_NO_CONTEXT:` 前缀。按类型/码判定，禁按文案匹配 → 与权限类同 ⇒ 403。
/** 上下文缺失判定（与权限类同档）：按类型 / machine code / 稳定前缀三分支 */
function isNoContextError(e) {
  if (!e) return false;
  if (e.code === 'no_context' || e.name === 'NoContextError') return true;
  return String((e && e.message) || e).startsWith('ERR_NO_CONTEXT:');
}

// 权限类（含同档 NoContext）统一判定
/** 权限类判定（权限错误 + 同档 NoContext） */
function isPermissionClass(e) {
  return isPermissionError(e) || isNoContextError(e);
}

// spec/04：非权限错误的稳定 machine code——`ERR_<CODE>:...` ⇒ `<CODE>`。
// message 原样保留（含前缀）；权限类走下方 FORBIDDEN 分支，不在此改写（code 只增不改）。
const ERR_PREFIX_RE = /^(ERR_[A-Z0-9_]+):/;

/** ERR_<CODE>: 前缀 → <CODE>；非该形态或权限前缀返回 null */
function stableErrorCode(message) {
  if (typeof message !== 'string') return null;
  const m = ERR_PREFIX_RE.exec(message);
  if (!m || m[1] === 'ERR_PERMISSION') return null;
  return m[1].slice('ERR_'.length);
}

// spec/04：错误呈现默认——非权限错误原样透出（parity py/go，符合本 spec「原样透传」）；
// `ERR_*` 前缀错误额外补 extensions.code（如 ERR_NOT_FOUND → NOT_FOUND），message 原文保留；
// 权限类错误执行期仍走 GraphQL over HTTP 的 200，靠 extensions.code = FORBIDDEN 区分
// （不设 extensions.http.status；剥前缀属展示层，走 opts.maskError）
// 形参仅 (error)：yoga 以 (error, message, isDev) 调用，本默认实现只需 error（message 原文保留、
// isDev 不参与判决），多余实参由 JS 容忍
/** 掩码用原始消息：优先 error.message，其次 originalError.message，缺省空串 */
function maskMessageOf(error, orig) {
  const m = (error && error.message) || (orig && orig.message);
  return String(m || '');
}

/** 非权限错误的掩码：保留原文与定位信息，缺失的 extensions.code 用稳定码补齐 */
function codedMasked(error, orig, raw, code) {
  return new GraphQLError(raw, {
    nodes: error && error.nodes,
    path: error && error.path,
    originalError: orig,
    extensions: {
      ...((error && error.extensions) || {}),
      // 已有 code（如守卫的旧值 ERR_DEPTH）原地不动，只补缺失的；
      // 规范化码另置 normalizedCode，由守卫自己写入。
      code: (error && error.extensions && error.extensions.code) || code,
    },
  });
}

/** 权限类（含同档 NoContext）掩码：extensions.code 定 FORBIDDEN，message 保留原样 */
function forbiddenMasked(error, orig) {
  return new GraphQLError(String((error && error.message) || ''), {
    nodes: error && error.nodes,
    path: error && error.path,
    originalError: orig,
    extensions: {
      ...((error && error.extensions) || {}),
      code: 'FORBIDDEN',
    },
  });
}

/** 默认错误掩码：权限类 → FORBIDDEN，其余补 extensions.code 并保留原文 */
function defaultMaskError(error) {
  const orig = (error && error.originalError) || error;
  if (isPermissionClass(error) || isPermissionClass(orig)) {
    return forbiddenMasked(error, orig);
  }
  const raw = maskMessageOf(error, orig);
  const code = stableErrorCode(raw);
  return code ? codedMasked(error, orig, raw, code) : error;
}

/**
 * fail-secure 装配守卫：宿主开启上下文强制却未配 contextFactory 时，装配期即拒绝
 * （fail-fast）；否则每请求在运行期以 ERR_NO_CONTEXT 失败（no-error-masking）。
 */
function assertSecureConfig(store, opts) {
  if (typeof store.requireContext === 'function' && store.requireContext() && !opts.contextFactory) {
    throw new Error(
      'ERR_SECURE_CONFIG: 宿主已开启上下文强制（fail-secure）但未配置 opts.contextFactory；'
      + '请注入从请求解析身份的 contextFactory（spec/04），'
      + '无需鉴权的内部服务请显式 store.setRequireContext(false) 后再装配',
    );
  }
}

// R2-04：policyProvider 可选注入（进程级全局单值状态，默认关闭 = 现状零变化）。
// 视图派生只许 store.baseView().withPolicy(overrides)（皮侧禁自持 Registry——R2-04 §7），
// 作用域原语 withScope 为 nodejs-store optional peer，仅注入 policyProvider 时才加载。
/** 取 store 的作用域包装（policyProvider 存在时每请求包 withScope；缺 baseView 即报错） */
function resolveWithScope(store) {
  if (typeof store.baseView !== 'function') {
    throw new Error(
      'ERR_POLICY_PROVIDER_CONFIG: 注入 policyProvider 需要宿主 store.baseView()'
      + '（nodejs-store 提供）；皮侧禁自持 Registry 派生视图（R2-04 §7）',
    );
  }
  try {
    return require('nodejs-store').withScope;
  } catch (e) {
    throw new Error(`ERR_DEPENDENCY_MISSING: 注入 policyProvider 需要安装 nodejs-store（withScope）: ${(e && e.message) || e}`);
  }
}

/** 加载 graphql-yoga（可选依赖） */
function loadYoga() {
  try {
    return require('graphql-yoga');
  } catch {
    throw new Error('使用 createYoga 需要安装 graphql-yoga（npm i graphql-yoga）；或仅用 buildGraphQLSchema 自行承载');
  }
}

/** 深度守卫：超限以 ERR_DEPTH 拦截（http 400） */
function assertDepth(document, depthLimit) {
  const d = queryDepthOf(document);
  if (d > depthLimit) {
    throw new GraphQLError(`ERR_DEPTH:查询深度 ${d} 超过上限 ${depthLimit}`, {
      extensions: { code: 'ERR_DEPTH', normalizedCode: 'DEPTH', http: { status: 400 } },
    });
  }
}

/** 复杂度 / introspection 守卫：超限或禁用期使用 introspection 均以 http 400 拦截 */
function assertFieldBudget(document, fieldsLimit, introspectionEnabled) {
  const { fields, introspectionUsed } = queryFieldCount(document);
  if (introspectionUsed && !introspectionEnabled) {
    throw new GraphQLError('ERR_INTROSPECTION:introspection 已禁用', {
      extensions: { code: 'ERR_INTROSPECTION', normalizedCode: 'INTROSPECTION', http: { status: 400 } },
    });
  }
  if (fields > fieldsLimit) {
    throw new GraphQLError(`ERR_COMPLEXITY:查询字段数 ${fields} 超过上限 ${fieldsLimit}`, {
      extensions: { code: 'ERR_COMPLEXITY', normalizedCode: 'COMPLEXITY', http: { status: 400 } },
    });
  }
}

/** spec/04:深度/复杂度/introspection 守卫(onExecute 期拦截,extensions.http.status 定 400) */
function guardPlugin(depthLimit, fieldsLimit, introspectionEnabled) {
  return {
    onExecute({ args }) {
      assertDepth(args.document, depthLimit);
      assertFieldBudget(args.document, fieldsLimit, introspectionEnabled);
    },
  };
}

/**
 * 每请求注入上下文：同步 contextFactory 走快路径——不引入 await 微任务，
 * 避免 AsyncLocalStorage.enterWith 在微任务里落地致上下文传不到 resolver
 * （返回 null 同样显式落地清除）。
 */
async function applyContext(store, contextFactory, req, serverCtx) {
  const maybe = contextFactory({ request: req, serverContext: serverCtx });
  const ctx = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
  store.setContext(ctx != null ? ctx : null);
  return ctx;
}

/** 包装层：每请求先跑 contextFactory 并按 spec/04 分类（403/401），再进 Yoga 执行 */
function createHandler(store, yoga, opts, policyProvider, withScopeFn) {
  return async (req, serverCtx) => {
    let ctx = null;
    if (opts.contextFactory) {
      try {
        ctx = await applyContext(store, opts.contextFactory, req, serverCtx);
      } catch (e) {
        return classifiedErrorResponse(e);
      }
    }
    // R2-04：policyProvider 收已解析 ctx（未配 contextFactory ⇒ null，禁二次调用 provider）；
    // 返回非空则派生视图并以 withScope 包裹 Yoga 执行（resolver 经 currentView() 读作用域视图）；
    // policyProvider 异常按 spec/04 同 contextFactory 分类（403/401），禁吞。
    if (policyProvider) {
      try {
        const overrides = policyProvider(ctx != null ? ctx : null);
        const view = overrides ? store.baseView().withPolicy(overrides) : null;
        return withScopeFn(view ? { view } : null, () => yoga(req, serverCtx));
      } catch (e) {
        return classifiedErrorResponse(e);
      }
    }
    return yoga(req, serverCtx);
  };
}

/**
 * spec/04：默认自定义掩码（原样透出 + 权限错误 403）；maskedErrors 直通 Yoga，maskError 单独覆盖
 * （Yoga v5 只认对象形态，传裸函数会被静默忽略退回默认掩码）。
 */
function resolveMaskedErrors(opts) {
  if (opts.maskedErrors !== undefined) return opts.maskedErrors;
  return { maskError: opts.maskError || defaultMaskError };
}

/** 装配 Yoga 实例：schema 构建 + 深度/字段守卫插件 + 掩码 + 可选端点 */
function createYoga(store, opts = {}) {
  assertSecureConfig(store, opts);
  const policyProvider = opts.policyProvider || null;
  const withScopeFn = policyProvider ? resolveWithScope(store) : null;
  const { createYoga: createYogaImpl } = loadYoga();
  const schema = opts.schema || buildGraphQLSchema(store, opts);
  const depthLimit = opts.maxQueryDepth != null ? opts.maxQueryDepth : MAX_QUERY_DEPTH;
  const fieldsLimit = opts.maxQueryFields != null ? opts.maxQueryFields : MAX_QUERY_FIELDS;
  const introspectionEnabled = opts.introspection !== false;
  const yoga = createYogaImpl({
    schema,
    logging: opts.logging != null ? opts.logging : false,
    // spec/04：请求体上限 1MB(Yoga 默认 25MB,显式收窄对齐 store-api 三端)
    maxRequestBodySize: 1 << 20,
    maskedErrors: resolveMaskedErrors(opts),
    plugins: [guardPlugin(depthLimit, fieldsLimit, introspectionEnabled)],
    // spec/04：context 在包装层注入（Yoga 的 context factory 无法自定义 HTTP 状态码）
    context: undefined,
    // 承载端点（Yoga 原生选项 graphqlEndpoint；缺省 /graphql。store-gateway 组合时透传自定义路径）
    ...(opts.endpoint ? { graphqlEndpoint: opts.endpoint } : {}),
  });
  return { yoga: createHandler(store, yoga, opts, policyProvider, withScopeFn), schema };
}

// ── spec/04：HTTP 承载（Fastify 插件；宿主与 store-gateway 的统一入口）──
// 默认 path '/graphql'；opts 透传 createYoga（contextFactory / 守卫阈值 / maskError / schema / resources / idField ...）
// 回拷响应头剔除长度/编码类：body 已经 res.text() 解码，原 content-length / content-encoding 与实际不符
const SKIP_RES_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

// spec/04：错误分类响应——权限类 403、其余 401，body 只含 message（不泄栈）。
// contextFactory / policyProvider 两处 catch 共用（同一分类与同一 JSON 形状）。
/** 错误分类响应：权限类 403、其余 401，body 只含 message（不泄栈） */
function classifiedErrorResponse(e) {
  const status = isPermissionClass(e) ? 403 : 401;
  return new Response(
    JSON.stringify({ errors: [{ message: String((e && e.message) || e) }] }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Fastify 插件入口：挂 GET/POST 路由，转 Request 调 yoga 并回写状态码/响应头 */
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
