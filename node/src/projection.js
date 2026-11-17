'use strict';

/**
 * spec/02 selection → GQL 投影串（D4-4 零语义拆分自 index.js）。
 *
 * fragments 展开 + @skip/@include 求值 + 空投影回退 _id。
 */

const { Kind } = require('graphql');

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

module.exports = { isConditionalDirective, directiveIfValue, shouldInclude, projectionFromResolveInfo };
