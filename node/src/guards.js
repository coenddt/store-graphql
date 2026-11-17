'use strict';

/**
 * spec/04 查询守卫：深度 / 复杂度 / introspection（D4-4 零语义拆分自 index.js）。
 *
 * 只做 AST 遍历与计数，不依赖 schema；阈值常量同处声明。
 */

const { Kind } = require('graphql');

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

module.exports = { MAX_QUERY_DEPTH, MAX_QUERY_FIELDS, isIntrospectionName, queryFieldCount, queryDepthOf };
