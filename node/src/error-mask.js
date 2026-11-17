'use strict';

/**
 * spec/04 错误呈现（D4-4 零语义拆分自 index.js）。
 *
 * 权限 / NoContext 判定、稳定 machine code 提取、默认掩码与 HTTP 错误分类响应。
 */

const { GraphQLError } = require('graphql');

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

module.exports = {
  isPermissionError,
  isNoContextError,
  isPermissionClass,
  stableErrorCode,
  defaultMaskError,
  classifiedErrorResponse,
};
