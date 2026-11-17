'use strict';

/**
 * spec/02 根 resolver 工厂（D4-4 零语义拆分自 index.js）。
 *
 * 投影下推（无 N+1）、limit 守卫与 `$near` 互斥判定。resolver 只经 store 端口取数。
 */

const { projectionFromResolveInfo } = require('./projection');

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

module.exports = {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  queryByIdRow,
  makeGet,
  makeList,
  makeCreate,
  makeUpdate,
  makeDelete,
  findByKey,
  vectorLimitGuard,
};
