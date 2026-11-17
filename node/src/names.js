'use strict';

/**
 * spec/01 模型名过滤（D4-4 零语义拆分自 index.js）。
 *
 * 归档表过滤（与 store-api 三端逐字一致）与 GraphQL 规范 `__` 保留名剔除。
 */

const ARCHIVE_SUFFIX = 'Deleted';

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

module.exports = { filterArchived, filterReserved };
