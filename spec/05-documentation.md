# 05 — 文档系统（GraphQL 文档三层）

GraphQL 的文档不是外挂物，而是 schema 的一部分。三层按依赖关系排列，下层是上层的数据源：

## 第 1 层：description 管道（SDL 文档注释，v0 必做）

defn 采用 JSON Schema 惯例的 `description` 键，生成器原样写入 SDL（三引号注释），随 introspection / GraphiQL / codegen 全链路携带：

```json
{
  "name": "User",
  "description": "用户表：平台账号主档",
  "fields": {
    "_id": { "type": "string", "description": "主键，u 前缀" },
    "name": { "type": "string" }
  }
}
```

| 对象 | 来源 |
|---|---|
| 模型类型 | `defn.description` |
| 字段（含 computes、嵌套对象字段） | `fieldDefn.description` |
| 嵌套对象类型 | 字段 defn 自身的 `description` |
| `JSON` 标量 | 固定说明（01 已定） |
| 生成参数（id/condition/sort/limit 等） | v0 不写（语义自明，宁缺毋滥） |

- **透传不改写**：description 是 store 侧作者对业务语义的陈述，适配层只搬运不发明——这是「适配层零语义发明」在文档面的延伸
- introspection 原生携带（`types.description` / `fields.description`），任何标准工具链可读

## 第 2 层：交互式 Explorer（GraphiQL，v0 必做）

`GET /graphql` 返回 GraphiQL 页面（CDN 版，文档页可接受外网依赖）；`POST /graphql` 才执行查询（spec/04 的 GET 查询执行仍列 v1）。

| 端 | v0 状态 |
|---|---|
| node | Yoga 原生 landing page（GraphiQL），零额外工作 |
| py | `create_app` 增加 `GET /graphql` → `HTMLResponse`（GraphiQL 模板） |
| go | `Handler` 对 GET 返回 GraphiQL HTML；POST 才走执行 |

GraphiQL 即文档系统本体：schema 浏览面板（读 introspection，含第 1 层 description）、自动补全、查询构建。

## 第 3 层：静态文档站（v1，不自造轮子）

`exportSDL()` 的产物是唯一出口，静态站生成器由使用者自接：

- 推荐 **SpectaQL**（Node，SDL → 静态站点，读 description）
- 或 **graphql-markdown**（SDL → Markdown，适合 GitHub Wiki）

适配层不做文档站生成器——SDL 已是完备的机器可读文档源，再实现一遍打印器就是语义旁路。
