"""adapter — py 端核心实现（语义依据 ../../spec/*.md，与 node 端镜像）。"""

import contextlib
import inspect
import json

from graphql import (
    GraphQLArgument,
    GraphQLBoolean,
    GraphQLField,
    GraphQLFloat,
    GraphQLID,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLSchema,
    GraphQLString,
    graphql,
    parse,
    print_schema,
)

# GraphQL AST kind 字符串(graphql-core 3.x 的 node.kind 即字符串,无 Kind 常量类)
K_FIELD = "field"
K_INLINE_FRAGMENT = "inline_fragment"
K_FRAGMENT_SPREAD = "fragment_spread"
K_VARIABLE = "variable"
K_BOOLEAN = "boolean"

ARCHIVE_SUFFIX = "Deleted"

# spec/02 limit 守卫常量:core 的行数封顶仅 text2query 档生效(standard 档原样返回),
# 适配层守上界;调整先改 spec 再三端同步。
LIST_LIMIT_DEFAULT = 50
LIST_LIMIT_MAX = 1000

# spec/01 pageX 分页常量:pageSize 上限对齐宿主 MAX_PAGE_SIZE;深翻页守 offset 上界。
# 调整先改 spec 再三端同步。
PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 5000
PAGE_MAX_OFFSET = 100000

# spec/04 查询深度守卫:深度 = 从 operation 顶层 selectionSet 起的最大字段嵌套层数,
# FragmentSpread 按定义递归(visiting 防环);超限 HTTP 400 + ERR_DEPTH: 稳定前缀。
MAX_QUERY_DEPTH = 10

# spec/04 复杂度守卫:AST 字段节点总数(别名不单列——字段计数已覆盖别名堆叠)。
MAX_QUERY_FIELDS = 300


def query_field_count(document):
    """字段计数 + introspection 使用检测(fragment 展开计入,防环;__typename 放行)。"""
    fragments = {
        d.name.value: d for d in document.definitions if d.kind == "fragment_definition"
    }
    out = {"fields": 0, "introspection_used": False}

    def walk_sel_set(sel_set, visiting):
        """递归累加 out["fields"] 并检测 introspection；fragment 展开计入，visiting 防环。"""
        if sel_set is None:
            return
        for sel in sel_set.selections:
            if sel.kind == K_FIELD:
                out["fields"] += 1
                name = sel.name.value
                if not out["introspection_used"] and name in ("__schema", "__type"):
                    out["introspection_used"] = True
                walk_sel_set(sel.selection_set, visiting)
            elif sel.kind == K_INLINE_FRAGMENT:
                walk_sel_set(sel.selection_set, visiting)
            elif sel.kind == K_FRAGMENT_SPREAD:
                if sel.name.value in visiting:
                    continue
                frag = fragments.get(sel.name.value)
                if frag:
                    walk_sel_set(frag.selection_set, visiting | {sel.name.value})

    for d in document.definitions:
        if d.kind == "operation_definition":
            walk_sel_set(d.selection_set, set())
    return out


def query_depth(document):
    """spec/04 深度守卫：计算各 operation 起的最大字段嵌套层数（FragmentSpread 按定义递归，visiting 防环）。"""
    fragments = {
        d.name.value: d for d in document.definitions if d.kind == "fragment_definition"
    }

    def depth_of_sel_set(sel_set, visiting):
        """返回该 selection set 的最大嵌套深度；空集为 0，fragment 展开递归计入。"""
        if sel_set is None:
            return 0
        max_d = 0
        for sel in sel_set.selections:
            if sel.kind == K_FIELD:
                d = 1 + depth_of_sel_set(sel.selection_set, visiting)
            elif sel.kind == K_INLINE_FRAGMENT:
                d = depth_of_sel_set(sel.selection_set, visiting)
            elif sel.kind == K_FRAGMENT_SPREAD:
                if sel.name.value in visiting:
                    continue
                frag = fragments.get(sel.name.value)
                d = (
                    depth_of_sel_set(frag.selection_set, visiting | {sel.name.value})
                    if frag
                    else 0
                )
            else:
                d = 0
            if d > max_d:
                max_d = d
        return max_d

    max_d = 0
    for d in document.definitions:
        if d.kind == "operation_definition":
            od = depth_of_sel_set(d.selection_set, set())
            if od > max_d:
                max_d = od
    return max_d


# spec/05：GraphiQL 文档页（CDN 版，GET /graphql 返回；POST 才执行查询）
GRAPHIQL_HTML = """<!doctype html>
<html lang="en">
<head>
  <title>store-graphql GraphiQL</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
  <style>body { margin: 0; } #graphiql { height: 100vh; }</style>
</head>
<body>
  <div id="graphiql">Loading GraphiQL...</div>
  <script crossorigin src="https://unpkg.com/react/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql/graphiql.min.js"></script>
  <script>
    function graphQLFetcher(graphQLParams) {
      return fetch('/graphql', {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graphQLParams),
      }).then(function (r) { return r.json(); });
    }
    ReactDOM.createRoot(document.getElementById('graphiql')).render(
      React.createElement(GraphiQL, { fetcher: graphQLFetcher })
    );
  </script>
</body>
</html>
"""

# ── spec/01：归档表过滤（与 store-api 三端逐字一致）──


def filter_archived(names):
    """spec/01 归档表过滤：剔除后缀 Deleted 且存在同名存续表的归档名（与 store-api 三端逐字一致）。"""
    s = set(names)
    return [
        n
        for n in names
        if not (n.endswith(ARCHIVE_SUFFIX) and n[: -len(ARCHIVE_SUFFIX)] in s)
    ]


# ── GraphQL 规范：`__` 前缀为 introspection 保留，不得作为类型名 ──
# core 注册的控制面内建模型（__workflowRun / __schemaDef / __workflowDef / __feedback）
# 一旦进 schema，assert_valid_schema 判「Name "__x" must not begin with "__"」→ 全 schema 失效。
# 该过滤为 GraphQL 皮专有约束（REST/gRPC/MCP 无此限制），故不并入与 store-api 逐字一致的
# filter_archived；按 GraphQL 规范无条件生效（含显式 resources 入参）。


def filter_reserved(names):
    """过滤 `__` 前缀的 GraphQL 保留名（introspection 约束），无条件生效、不受 include_archived 影响。"""
    return [n for n in names if not n.startswith("__")]


# ── spec/01：JSON 标量（只接受 variables 传入）──

GraphQLJSON = GraphQLScalarType(
    name="JSON",
    description="任意 JSON 值（条件/排序/写入文档）。只接受 variables 形式（spec/02）。",
    serialize=lambda v: v,
    parse_value=lambda v: v,
    parse_literal=lambda _node, *_a: (_ for _ in ()).throw(
        ValueError("JSON 标量只接受 variables 传入（spec/02）")
    ),
)


# ── spec/01：defn 字段类型 → GraphQL 输出类型 ──


def _scalar_for(type_name):
    """defn 标量类型名 → GraphQL 标量类型；未登记的类型返回 None。"""
    return {
        "string": GraphQLString,
        "datetime": GraphQLString,
        "int": GraphQLInt,
        "float": GraphQLFloat,
        "bool": GraphQLBoolean,
    }.get(type_name)


def _out_type(field_defn, type_name):
    """字段定义 → 输出类型：object 嵌套递归成 GraphQLObjectType，否则映射标量、兜底 JSON。"""
    if field_defn.get("type") == "object" and "fields" in field_defn:
        return GraphQLObjectType(
            name=type_name,
            description=field_defn.get(
                "description"
            ),  # spec/05：description 透传不改写
            fields=lambda: _map_fields(field_defn["fields"], type_name),
        )
    return _scalar_for(field_defn.get("type")) or GraphQLJSON


def _map_fields(fields, type_name):
    """字段字典 → GraphQLField 映射：_id 强制非空 ID，description 透传（spec/05，含 computes 与嵌套字段）。"""
    return {
        k: GraphQLField(
            GraphQLNonNull(GraphQLID)
            if k == "_id"
            else _out_type(v, f"{type_name}_{k}"),
            description=v.get("description"),  # spec/05：含 computes 与嵌套字段
        )
        for k, v in (fields or {}).items()
    }


def _model_fields(defn):
    """合并 fields 与 computes（computes 视同字段，spec/01）并恒注入可空的 _score 向量检索派生列（spec/04）。"""
    merged = dict(defn.get("fields") or {})
    merged.update(defn.get("computes") or {})  # spec/01：computes 视同字段
    # `_score`：向量检索派生列（04），恒注入且可空
    merged["_score"] = {
        "type": "float",
        "description": "向量检索相似度得分（越大越相似）",
    }
    return merged


# ── spec/02：selection → GQL 投影串 ──


def _should_include(node, variables):
    """按 @skip/@include 指令（if 支持变量与布尔字面量）判定 selection 是否纳入投影；无指令默认纳入。"""
    for d in node.directives or ():
        if d.name.value not in ("skip", "include"):
            continue
        if_arg = next((a for a in d.arguments or () if a.name.value == "if"), None)
        if if_arg is None:
            continue
        if if_arg.value.kind == K_VARIABLE:
            val = (variables or {}).get(if_arg.value.name.value)
        elif if_arg.value.kind == K_BOOLEAN:
            val = if_arg.value.value
        else:
            continue
        if val is None:
            continue
        if d.name.value == "skip" and val:
            return False
        if d.name.value == "include" and not val:
            return False
    return True


def _projection_from_selection(info, selection_set):
    """把 selection set 展开成 GQL 投影串（alias 忽略，spec/02 v0）；全空兜底 `_id`。"""
    if selection_set is None:
        return "_id"
    variables = info.variable_values
    if not isinstance(
        variables, dict
    ):  # graphql-core 3.3 的 VariableValues 对象,强制值在 .coerced
        variables = getattr(variables, "coerced", None) or {}

    def walk(sel):
        """单个 selection → 投影片段；字段按 skip/include 过滤并递归展开，fragment/spread 展开其 selections。"""
        if sel.kind == K_FIELD:
            if not _should_include(sel, variables):
                return None
            head = sel.name.value  # alias v0 忽略（spec/02）
            if sel.selection_set:
                inner = ", ".join(
                    filter(None, (walk(s) for s in sel.selection_set.selections))
                )
                if inner:
                    return f"{head} {{ {inner} }}"
            return head
        if sel.kind == K_INLINE_FRAGMENT:
            return ", ".join(
                filter(None, (walk(s) for s in sel.selection_set.selections))
            )
        if sel.kind == K_FRAGMENT_SPREAD:
            frag = (info.fragments or {}).get(sel.name.value)
            if frag is None:
                return None
            return ", ".join(
                filter(None, (walk(s) for s in frag.selection_set.selections))
            )
        return None

    return (
        ", ".join(filter(None, (walk(s) for s in selection_set.selections))) or "_id"
    )


def projection_from_info(info):
    """把根字段的 GraphQL selection 展开成 GQL 投影串下推给 store（spec/02）。"""
    root = next((n for n in info.field_nodes if n.kind == K_FIELD), None)
    if root is None:
        return "_id"
    return _projection_from_selection(info, root.selection_set)


def _find_field(info, selection_set, name, visiting=None):
    """在 selection set 中按字段名查找（fragment 展开，visiting 防环）。"""
    visiting = visiting or set()
    if selection_set is None:
        return None
    for sel in selection_set.selections:
        if sel.kind == K_FIELD and sel.name.value == name:
            return sel
        if sel.kind == K_INLINE_FRAGMENT:
            hit = _find_field(info, sel.selection_set, name, visiting)
            if hit is not None:
                return hit
        elif sel.kind == K_FRAGMENT_SPREAD:
            frag_name = sel.name.value
            if frag_name in visiting:
                continue
            frag = (info.fragments or {}).get(frag_name)
            if frag is not None:
                hit = _find_field(
                    info, frag.selection_set, name, visiting | {frag_name}
                )
                if hit is not None:
                    return hit
    return None


def projection_for_field(info, field_name):
    """取根字段下指定子字段的 selection 投影（pageX 的 items 用）。"""
    root = next((n for n in info.field_nodes if n.kind == K_FIELD), None)
    child = _find_field(info, root.selection_set if root is not None else None, field_name)
    return _projection_from_selection(info, child.selection_set if child else None)


# ── spec/02：根 resolver（投影下推，无 N+1）──


def _make_get(store, name, id_field):
    """生成 get{name} resolver 工厂：按 id 条件下推投影查询单条（spec/02，无 N+1）。"""

    async def resolve(_src, info, *, id):
        """以 selection 投影按 id 查询，返回首行（无则 None）。"""
        projection = projection_from_info(info)
        rows = await store.query(
            f"{name}($condition:@c0) {{ {projection} }}", {"c0": {id_field: id}}
        )
        return rows[0] if rows else None

    return resolve


def _find_key(node, key):
    """深度优先找第一个同名键（`$near` 只允许出现一次，由 core 保证）。"""
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for v in node.values():
            hit = _find_key(v, key)
            if hit is not None:
                return hit
    elif isinstance(node, (list, tuple)):
        for v in node:
            hit = _find_key(v, key)
            if hit is not None:
                return hit
    return None


def _vector_limit_guard(condition, explicit_limit):
    """含 `$near` → 返回 True（不拼根 `$limit`）；显式 limit 并用 → ERR_LIMIT。"""
    near = _find_key(condition, "$near")
    if near is None:
        return False
    if explicit_limit is not None:
        raise ValueError(
            "ERR_LIMIT:list limit 与 $near.$limit 互斥，请只传 $near.$limit"
        )
    if isinstance(near, dict):
        n = near.get("$limit")
        if isinstance(n, int) and n > LIST_LIMIT_MAX:
            raise ValueError(f"ERR_LIMIT:$near.$limit 上限 {LIST_LIMIT_MAX},收到 {n}")
    return True


def _make_list(store, name):
    """生成 list{name} resolver 工厂：condition/sort/limit 参数化下推，含 limit 守卫与 $near 互斥处理（spec/02）。"""

    async def resolve(_src, info, *, condition=None, sort=None, limit=None):
        """组装 `$condition/@c0`、`$sort/@s1`、`$limit/@l` 下推查询；limit 缺省 50、超上限抛 ERR_LIMIT。"""
        has_near = _vector_limit_guard(condition, limit)
        # spec/02 limit 守卫:缺省 50 防全表;超上限抛错(ERR_LIMIT: 稳定前缀),不静默截断
        if limit is None:
            limit = LIST_LIMIT_DEFAULT
        if not has_near and limit > LIST_LIMIT_MAX:
            raise ValueError(f"ERR_LIMIT:list limit 上限 {LIST_LIMIT_MAX},收到 {limit}")
        projection = projection_from_info(info)
        head = name
        parts, params = [], {}
        if condition is not None:
            parts.append("$condition:@c0")
            params["c0"] = condition
        if sort is not None:
            parts.append("$sort:@s1")
            params["s1"] = sort
        if not has_near:  # 向量查询的条数唯一来源是 $near.$limit
            parts.append("$limit:@l")
            params["l"] = limit
        head += f"({','.join(parts)})"
        return await store.query(f"{head} {{ {projection} }}", params)

    return resolve


def _assert_page_bounds(page, page_size):
    """spec/01 pageX：解析并校验分页参数，越界抛 ERR_LIMIT（不静默截断/夹取）。"""
    p = 0 if page is None else page
    ps = PAGE_SIZE_DEFAULT if page_size is None else page_size
    if not isinstance(p, int) or isinstance(p, bool) or p < 0:
        raise ValueError(f"ERR_LIMIT:page 必须是非负整数,收到 {page}")
    if not isinstance(ps, int) or isinstance(ps, bool) or ps <= 0:
        raise ValueError(f"ERR_LIMIT:pageSize 必须是正整数,收到 {page_size}")
    if ps > PAGE_SIZE_MAX:
        raise ValueError(f"ERR_LIMIT:pageSize 上限 {PAGE_SIZE_MAX},收到 {ps}")
    if p * ps > PAGE_MAX_OFFSET:
        raise ValueError(f"ERR_LIMIT:page*pageSize 上限 {PAGE_MAX_OFFSET},收到 {p * ps}")
    return p, ps


def _make_page(store, name):
    """生成 page{name} resolver 工厂：走宿主 query_with_count，投影只下推 items 子选择（spec/01）。"""

    async def resolve(_src, info, *, condition=None, sort=None, page=None, pageSize=None):
        """校验分页参数后调用宿主计数查询，返回 {items,total,hasMore,page,pageSize}。"""
        counter = getattr(store, "query_with_count", None) or getattr(
            store, "queryWithCount", None
        )
        if not callable(counter):
            raise ValueError(
                "ERR_CAPABILITY:宿主 store 未提供 query_with_count，pageX 不可用（spec/00）"
            )
        if _find_key(condition, "$near") is not None:
            raise ValueError("ERR_LIMIT:pageX 与 $near 向量检索互斥（向量检索无 offset 语义）")
        p, ps = _assert_page_bounds(page, pageSize)
        projection = projection_for_field(info, "items")
        parts, params = [], {"page": p, "pageSize": ps}
        if condition is not None:
            parts.append("$condition:@c0")
            params["c0"] = condition
        if sort is not None:
            parts.append("$sort:@s1")
            params["s1"] = sort
        head = f"{name}({','.join(parts)})" if parts else name
        res = await counter(f"{head} {{ {projection} }}", params)
        return {
            "items": res["items"],
            "total": res["total"],
            "hasMore": res["hasMore"],
            "page": res["page"],
            "pageSize": res["pageSize"],
        }

    return resolve


def _make_create(store, name):
    """生成 create{name} resolver 工厂：input 直接透传 store.insert。"""

    async def resolve(_src, _info, *, input):
        """将 input 文档透传 store.insert 并返回插入结果。"""
        return await store.insert(name, input)

    return resolve


def _make_update(store, name, id_field):
    """生成 update{name} resolver 工厂：按 id_field 定位更新 set 后回查返回最新文档。"""

    async def resolve(_src, info, *, id, set):
        """先按 id 更新 set，再以 selection 投影回查返回该行。"""
        await store.update(name, {id_field: id}, set)
        projection = projection_from_info(info)
        rows = await store.query(
            f"{name}($condition:@c0) {{ {projection} }}", {"c0": {id_field: id}}
        )
        return rows[0] if rows else None

    return resolve


def _make_delete(store, name, id_field):
    """生成 delete{name} resolver 工厂：按 id_field 定位删除并恒返回 True。"""

    async def resolve(_src, _info, *, id):
        """按 id 调 store.remove 删除文档，恒返回 True。"""
        await store.remove(name, {id_field: id})
        return True

    return resolve


# ── schema 构建 ──


def build_graphql_schema(
    store,
    *,
    resources=None,
    overrides=None,
    extensions=None,
    id_field="_id",
    include_archived=False,
):
    """把 store schema 构建成 GraphQLSchema：每模型生成 get/list/create/update/delete 五件套，含 override/extensions 钩子与归档、`__` 保留名过滤（spec/01、03）。"""
    overrides = dict(overrides or {})
    extensions = dict(extensions or {})
    # spec/01：默认过滤归档表；include_archived=True 为显式开关（点名要看归档的人能拿到）。
    # `__` 保留名过滤不受该开关影响。
    raw_names = resources if resources is not None else store.list()
    names = filter_reserved(
        raw_names if include_archived else filter_archived(raw_names)
    )

    query_fields = {}
    mutation_fields = {}
    used_override_keys = set()

    def resolve_with_override(key, fallback):
        """override 命中则记入 used_override_keys 并返回之，否则返回默认 resolver。"""
        fn = overrides.get(key)
        if fn is not None:
            used_override_keys.add(key)
        return fn or fallback

    for name in names:
        defn = store.get(name)
        xg = defn.get("x-graphql") or {}
        if xg.get("hidden"):  # spec/03 钩子 1：模型级 hidden
            continue
        model_type = GraphQLObjectType(
            name=name,
            description=defn.get("description"),  # spec/05
            # n=name 显式捕获:延迟 thunk 求值时循环变量已到末值,会造成嵌套类型重名
            fields=lambda d=defn, n=name: _map_fields(_model_fields(d), n),
        )

        query_fields[f"get{name}"] = GraphQLField(
            model_type,
            args={"id": GraphQLArgument(GraphQLNonNull(GraphQLID))},
            resolve=resolve_with_override(
                f"Query.get{name}", _make_get(store, name, id_field)
            ),
        )
        query_fields[f"list{name}"] = GraphQLField(
            GraphQLNonNull(GraphQLList(GraphQLNonNull(model_type))),
            args={
                "condition": GraphQLArgument(GraphQLJSON),
                "sort": GraphQLArgument(GraphQLJSON),
                "limit": GraphQLArgument(GraphQLInt),
            },
            resolve=resolve_with_override(f"Query.list{name}", _make_list(store, name)),
        )
        # spec/01 pageX：列表 + total + hasMore（宿主 query_with_count 的薄暴露）
        page_type = GraphQLObjectType(
            name=f"{name}Page",
            description=f"{name} 分页结果（items + total + hasMore + page + pageSize）",
            fields={
                "items": GraphQLField(
                    GraphQLNonNull(GraphQLList(GraphQLNonNull(model_type)))
                ),
                "total": GraphQLField(GraphQLNonNull(GraphQLInt)),
                "hasMore": GraphQLField(GraphQLNonNull(GraphQLBoolean)),
                "page": GraphQLField(GraphQLNonNull(GraphQLInt)),
                "pageSize": GraphQLField(GraphQLNonNull(GraphQLInt)),
            },
        )
        query_fields[f"page{name}"] = GraphQLField(
            GraphQLNonNull(page_type),
            args={
                "condition": GraphQLArgument(GraphQLJSON),
                "sort": GraphQLArgument(GraphQLJSON),
                "page": GraphQLArgument(GraphQLInt),
                "pageSize": GraphQLArgument(GraphQLInt),
            },
            resolve=resolve_with_override(f"Query.page{name}", _make_page(store, name)),
        )
        if not xg.get("readonly"):  # spec/03 钩子 1：模型级 readonly → 只出 Query
            mutation_fields[f"create{name}"] = GraphQLField(
                model_type,
                args={"input": GraphQLArgument(GraphQLNonNull(GraphQLJSON))},
                resolve=resolve_with_override(
                    f"Mutation.create{name}", _make_create(store, name)
                ),
            )
            mutation_fields[f"update{name}"] = GraphQLField(
                model_type,
                args={
                    "id": GraphQLArgument(GraphQLNonNull(GraphQLID)),
                    "set": GraphQLArgument(GraphQLNonNull(GraphQLJSON)),
                },
                resolve=resolve_with_override(
                    f"Mutation.update{name}", _make_update(store, name, id_field)
                ),
            )
            mutation_fields[f"delete{name}"] = GraphQLField(
                GraphQLNonNull(GraphQLBoolean),
                args={"id": GraphQLArgument(GraphQLNonNull(GraphQLID))},
                resolve=resolve_with_override(
                    f"Mutation.delete{name}", _make_delete(store, name, id_field)
                ),
            )

    # spec/03 钩子 3：extend（SDL 同步追加）
    for key, fields in extensions.items():
        if key == "Query":
            query_fields.update(fields)
        elif key == "Mutation":
            mutation_fields.update(fields)
        else:
            raise ValueError(
                f'extensions 仅支持 Query/Mutation，收到 "{key}"（spec/03）'
            )

    # spec/03：override 键构建期校验，未知路径报错不静默
    for key in overrides:
        if key not in used_override_keys:
            raise ValueError(f'override 路径 "{key}" 未命中任何生成字段（spec/03）')

    return GraphQLSchema(
        query=GraphQLObjectType(name="Query", fields=lambda: query_fields),
        mutation=(
            GraphQLObjectType(name="Mutation", fields=lambda: mutation_fields)
            if mutation_fields
            else None
        ),
    )


def export_sdl(schema):
    """spec/01：SDL 导出（喂客户端 codegen）。"""
    return print_schema(schema)


def _stable_error_code(message):
    """非权限错误的稳定 machine code：`ERR_<CODE>:...` ⇒ `<CODE>`。

    message 原样保留（含前缀）；权限类（ERR_PERMISSION:）不在此改写（code 只增不改）。
    未知/无冒号前缀 ⇒ None（保持原样，不吞成通用错误）。
    """
    if not isinstance(message, str) or not message.startswith("ERR_"):
        return None
    head, sep, _ = message.partition(":")
    if not sep:
        return None
    code = head[len("ERR_") :]
    if code == "PERMISSION" or not code.isupper():
        return None
    return code


def _is_permission_class(err, permission_error):
    """权限类（含同档 NoContext）判定：按类型 / machine code / 稳定前缀，禁按中文文案。"""
    orig = getattr(err, "original_error", None) or err
    if permission_error is not None and isinstance(orig, permission_error):
        return True
    if getattr(orig, "code", None) == "no_context":
        return True
    msg = getattr(orig, "message", None) or str(orig) or ""
    return msg.startswith("ERR_PERMISSION:") or msg.startswith("ERR_NO_CONTEXT:")


def _error_payload(err):
    """GraphQLError → 响应 error 项；非权限 `ERR_*` 前缀额外补 extensions.code。"""
    formatted = dict(err.formatted)
    extensions = formatted.get("extensions")
    if isinstance(extensions, dict) and extensions.get("code"):
        return formatted
    code = _stable_error_code(formatted.get("message") or getattr(err, "message", None))
    if code:
        formatted["extensions"] = {**(extensions or {}), "code": code}
    return formatted


def _forbidden_payload(err):
    """权限类错误呈现（spec/04）：执行期 HTTP 200 + `extensions.code = FORBIDDEN`；message 原样保留前缀。"""
    formatted = dict(err.formatted)
    extensions = dict(formatted.get("extensions") or {})
    extensions["code"] = "FORBIDDEN"
    formatted["extensions"] = extensions
    return formatted


# ── spec/04：HTTP 承载（FastAPI，可选依赖） ──


def create_app(
    store,
    *,
    schema=None,
    path="/graphql",
    context_provider=None,
    policy_provider=None,
    permission_error=None,
    resources=None,
    overrides=None,
    extensions=None,
    id_field="_id",
    include_archived=False,
    max_query_depth=None,
    max_query_fields=None,
    introspection=True,
):
    """FastAPI 应用工厂（spec/04）：POST 路由执行查询（1MB / 深度 / 复杂度 / introspection 守卫），GET 返回 GraphiQL 文档页。"""
    # fail-secure 装配守卫：宿主开启上下文强制却未配 context_provider 时，装配期即
    # 拒绝（fail-fast）；否则每请求在运行期以 ERR_NO_CONTEXT 失败（no-error-masking）。
    require_context = getattr(store, "require_context", None)
    if callable(require_context) and require_context() and context_provider is None:
        raise RuntimeError(
            "ERR_SECURE_CONFIG: 宿主已开启上下文强制（fail-secure）但未配置 context_provider；"
            "请注入从请求解析身份的 context_provider（spec/04），"
            "无需鉴权的内部服务请显式 store.set_require_context(False) 后再装配"
        )

    # R2-04：policy_provider 可选注入（进程级全局单值状态，默认关闭 = 现状零变化）。
    # 视图派生只许 store.base_view().with_policy(overrides)（皮侧禁自持 Registry——R2-04 §7），
    # 作用域原语 with_scope 为 py-store optional peer，仅注入 policy_provider 时才加载。
    _with_scope = None
    if policy_provider is not None:
        if not callable(getattr(store, "base_view", None)):
            raise RuntimeError(
                "ERR_POLICY_PROVIDER_CONFIG: 注入 policy_provider 需要宿主 store.base_view()"
                "（py-store 提供）；皮侧禁自持 Registry 派生视图（R2-04 §7）"
            )
        try:
            from py_store import with_scope as _with_scope
        except Exception as e:
            raise RuntimeError(
                f"ERR_DEPENDENCY_MISSING: 注入 policy_provider 需要安装 py-store（with_scope）: {e}"
            ) from e

    try:
        from fastapi import FastAPI, Request
        from fastapi.responses import HTMLResponse, JSONResponse
    except ImportError as e:
        raise ImportError(
            "create_app 需要安装 fastapi：pip install 'store-graphql-py[fastapi]'；"
            "或仅用 build_graphql_schema 自行承载"
        ) from e

    app = FastAPI(title="store-graphql")
    gql_schema = schema or build_graphql_schema(
        store,
        resources=resources,
        overrides=overrides,
        extensions=extensions,
        id_field=id_field,
        include_archived=include_archived,
    )
    if permission_error is None:
        permission_error = getattr(store, "PermissionError", None)

    @app.get(path)
    async def graphiql_page():
        """GET 路由：返回 CDN 版 GraphiQL 文档页（执行走 POST，spec/05）。"""
        # spec/05：GET 返回 GraphiQL 文档页（执行走 POST；GET 查询执行列 v1）
        return HTMLResponse(GRAPHIQL_HTML)

    @app.post(path)
    async def graphql_endpoint(request: Request):
        """POST 路由：1MB/JSON 校验 → context/policy 解析（403/401 分类）→ 深度/复杂度/introspection 守卫 → 执行并组装错误 payload。"""
        raw = await request.body()
        # spec/04：请求体上限 1MB（对齐 store-api 三端，防大 body 撑内存）
        if len(raw) > (1 << 20):
            return JSONResponse(
                status_code=413,
                content={"errors": [{"message": "请求体超过 1MB 上限（spec/04）"}]},
            )
        try:
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError("body 不是 JSON 对象")
        except Exception:
            return JSONResponse(
                status_code=400, content={"errors": [{"message": "请求体必须是 JSON"}]}
            )
        ctx = None  # R2-04：未配 context_provider 时 policy_provider 收显式 null
        if context_provider is not None:
            try:
                ctx = context_provider(request)
                if inspect.isawaitable(ctx):
                    ctx = await ctx
            except Exception as e:
                is_perm = (
                    permission_error is not None and isinstance(e, permission_error)
                ) or getattr(e, "code", None) == "no_context"
                status = 403 if is_perm else 401
                return JSONResponse(
                    status_code=status,
                    content={"errors": [{"message": str(e) or "CONTEXT_ERROR"}]},
                )
            # spec/04：None 同样显式注入（清除语义必须落地，防身份跨请求残留）
            store.set_context(ctx)
        # R2-04：policy_provider 收已解析 ctx（禁二次调用 provider）；返回非空则派生视图，
        # 供执行段 with_scope 包裹（resolver 经 current_scope() 读作用域视图）；
        # policy_provider 异常按 spec/04 同 context_provider 分类（403/401），禁吞。
        view = None
        if policy_provider is not None:
            try:
                overrides = policy_provider(ctx)
                view = (
                    store.base_view().with_policy(overrides)
                    if overrides is not None
                    else None
                )
            except Exception as e:
                is_perm = (
                    permission_error is not None and isinstance(e, permission_error)
                ) or getattr(e, "code", None) == "no_context"
                status = 403 if is_perm else 401
                return JSONResponse(
                    status_code=status,
                    content={"errors": [{"message": str(e) or "CONTEXT_ERROR"}]},
                )
        # spec/04 深度/复杂度/introspection 守卫:执行前独立 parse 检查
        # (语法错不在此拦,维持执行器原路径;双 parse 成本微秒级,如实标注 spec/04)
        depth_limit = MAX_QUERY_DEPTH if max_query_depth is None else max_query_depth
        fields_limit = (
            MAX_QUERY_FIELDS if max_query_fields is None else max_query_fields
        )
        query_str = body.get("query") or ""
        try:
            doc = parse(query_str)
        except Exception:
            doc = None
        if doc is not None:
            depth = query_depth(doc)
            if depth > depth_limit:
                return JSONResponse(
                    status_code=400,
                    content={
                        "errors": [
                            {
                                "message": f"ERR_DEPTH:查询深度 {depth} 超过上限 {depth_limit}",
                                "extensions": {
                                    "code": "ERR_DEPTH",
                                    "normalizedCode": "DEPTH",
                                },
                            }
                        ]
                    },
                )
            usage = query_field_count(doc)
            if usage["introspection_used"] and not introspection:
                return JSONResponse(
                    status_code=400,
                    content={
                        "errors": [
                            {
                                "message": "ERR_INTROSPECTION:introspection 已禁用",
                                "extensions": {
                                    "code": "ERR_INTROSPECTION",
                                    "normalizedCode": "INTROSPECTION",
                                },
                            }
                        ]
                    },
                )
            if usage["fields"] > fields_limit:
                return JSONResponse(
                    status_code=400,
                    content={
                        "errors": [
                            {
                                "message": f"ERR_COMPLEXITY:查询字段数 {usage['fields']} 超过上限 {fields_limit}",
                                "extensions": {
                                    "code": "ERR_COMPLEXITY",
                                    "normalizedCode": "COMPLEXITY",
                                },
                            }
                        ]
                    },
                )
        # R2-04：resolver 执行段包进视图作用域（深度/复杂度守卫与 payload 组装不触
        # resolver，无需进作用域；未注入 policy_provider ⇒ nullcontext 零行为变化）
        exec_scope = (
            _with_scope(view)
            if policy_provider is not None
            else contextlib.nullcontext()
        )
        with exec_scope:
            result = await graphql(
                gql_schema,
                query_str,
                variable_values=body.get("variables"),
                operation_name=body.get("operationName"),
            )
        payload = {"data": result.data}
        if result.errors:
            # spec/04：执行期权限类（含同档 NoContext）保持 GraphQL over HTTP 的 200，
            # 靠 extensions.code = FORBIDDEN 区分（不按状态码分叉）；其余错误仅补 extensions.code。
            payload["errors"] = [
                _forbidden_payload(e)
                if _is_permission_class(e, permission_error)
                else _error_payload(e)
                for e in result.errors
            ]
            return JSONResponse(payload)
        return JSONResponse(payload)

    return app
