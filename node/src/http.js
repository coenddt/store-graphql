'use strict';

/**
 * spec/04 HTTP 承载（Fastify 插件；D4-4 零语义拆分自 index.js）。
 *
 * 挂 GET/POST 路由，转 Request 调 Yoga 并回写状态码 / 响应头。
 */

const { createYoga } = require('./yoga');

// 默认 path '/graphql'；opts 透传 createYoga（contextFactory / 守卫阈值 / maskError / schema / resources / idField ...）
// 回拷响应头剔除长度/编码类：body 已经 res.text() 解码，原 content-length / content-encoding 与实际不符
const SKIP_RES_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

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

module.exports = { SKIP_RES_HEADERS, graphqlPlugin };
