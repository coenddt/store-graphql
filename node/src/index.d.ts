/**
 * store-graphql-node 类型声明（手写，与 src/index.js 的 module.exports 一一对应）。
 *
 * 口径：GraphQL Schema / DocumentNode / Yoga 实例均为外部库类型，此处用结构化
 * 占位（any / 最小接口）避免硬依赖 graphql 与 graphql-yoga 的类型包。
 */

/** 归档表过滤：剔除「有同名存续表」的 <名>Deleted */
export function filterArchived(names: string[]): string[]

/** JSON 标量（任意 JSON 值；只接受 variables 形式，spec/02） */
export const GraphQLJSON: any

/** 由 store schema 构建 GraphQLSchema */
export function buildGraphQLSchema(store: any, opts?: any): any

/** 导出 SDL 文本（喂客户端 codegen） */
export function exportSDL(schema: any): string

/** createYoga 返回：HTTP handler + 构建出的 schema */
export interface YogaBundle {
  yoga: (req: any, reply: any) => Promise<any>
  schema: any
}

/** 装配 Yoga 实例：schema 构建 + 深度 / 字段守卫插件 + 掩码 + 可选端点 */
export function createYoga(store: any, opts?: any): YogaBundle

/** Fastify 插件：把 GraphQL 端点挂到实例上（宿主与 store-gateway 的统一入口） */
export function graphqlPlugin(fastify: any, opts?: any): Promise<void>

/** 统计查询文档的字段数（守卫用） */
export function queryFieldCount(document: any): number

/** 计算查询文档的最大深度（守卫用） */
export function queryDepthOf(document: any): number
