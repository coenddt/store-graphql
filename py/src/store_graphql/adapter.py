"""adapter — py 端核心实现（语义依据 ../../spec/*.md，与 node 端镜像）。"""

import inspect

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
    print_schema,
)

# GraphQL AST kind 字符串(graphql-core 3.x 的 node.kind 即字符串,无 Kind 常量类)
K_FIELD = "field"
K_INLINE_FRAGMENT = "inline_fragment"
K_FRAGMENT_SPREAD = "fragment_spread"
K_VARIABLE = "variable"
K_BOOLEAN = "boolean"

ARCHIVE_SUFFIX = "Deleted"

# ── spec/01：归档表过滤（与 store-api 三端逐字一致）──


def filter_archived(names):
    s = set(names)
    return [
        n
        for n in names
        if not (n.endswith(ARCHIVE_SUFFIX) and n[: -len(ARCHIVE_SUFFIX)] in s)
    ]


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
    return {
        "string": GraphQLString,
        "datetime": GraphQLString,
        "int": GraphQLInt,
        "float": GraphQLFloat,
        "bool": GraphQLBoolean,
    }.get(type_name)


def _out_type(field_defn, type_name):
    if field_defn.get("type") == "object" and "fields" in field_defn:
        return GraphQLObjectType(
            name=type_name,
            fields=lambda: _map_fields(field_defn["fields"], type_name),
        )
    return _scalar_for(field_defn.get("type")) or GraphQLJSON


def _map_fields(fields, type_name):
    return {
        k: GraphQLField(
            GraphQLNonNull(GraphQLID) if k == "_id" else _out_type(v, f"{type_name}_{k}")
        )
        for k, v in (fields or {}).items()
    }


def _model_fields(defn):
    merged = dict(defn.get("fields") or {})
    merged.update(defn.get("computes") or {})  # spec/01：computes 视同字段
    return merged


# ── spec/02：selection → GQL 投影串 ──


def _should_include(node, variables):
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


def projection_from_info(info):
    root = next((n for n in info.field_nodes if n.kind == K_FIELD), None)
    if root is None or root.selection_set is None:
        return "_id"
    variables = info.variable_values
    if not isinstance(variables, dict):  # graphql-core 3.3 的 VariableValues 对象,强制值在 .coerced
        variables = getattr(variables, "coerced", None) or {}

    def walk(sel):
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

    return ", ".join(filter(None, (walk(s) for s in root.selection_set.selections))) or "_id"


# ── spec/02：根 resolver（投影下推，无 N+1）──


def _make_get(store, name, id_field):
    async def resolve(_src, info, *, id):
        projection = projection_from_info(info)
        rows = await store.query(
            f"{name}($condition:@c0) {{ {projection} }}", {"c0": {id_field: id}}
        )
        return rows[0] if rows else None

    return resolve


def _make_list(store, name):
    async def resolve(_src, info, *, condition=None, sort=None, limit=None):
        projection = projection_from_info(info)
        head = name
        parts, params = [], {}
        if condition is not None:
            parts.append("$condition:@c0")
            params["c0"] = condition
        if sort is not None:
            parts.append("$sort:@s1")
            params["s1"] = sort
        if limit is not None:
            parts.append("$limit:@l")
            params["l"] = limit
        if parts:
            head += f"({','.join(parts)})"
        return await store.query(f"{head} {{ {projection} }}", params)

    return resolve


def _make_create(store, name):
    async def resolve(_src, _info, *, input):
        return await store.insert(name, input)

    return resolve


def _make_update(store, name, id_field):
    async def resolve(_src, info, *, id, set):
        await store.update(name, {id_field: id}, set)
        projection = projection_from_info(info)
        rows = await store.query(
            f"{name}($condition:@c0) {{ {projection} }}", {"c0": {id_field: id}}
        )
        return rows[0] if rows else None

    return resolve


def _make_delete(store, name, id_field):
    async def resolve(_src, _info, *, id):
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
):
    overrides = dict(overrides or {})
    extensions = dict(extensions or {})
    names = resources if resources is not None else filter_archived(store.list())

    query_fields = {}
    mutation_fields = {}
    used_override_keys = set()

    def resolve_with_override(key, fallback):
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
            # n=name 显式捕获:延迟 thunk 求值时循环变量已到末值,会造成嵌套类型重名
            name=name, fields=lambda d=defn, n=name: _map_fields(_model_fields(d), n)
        )

        query_fields[f"get_{name}"] = GraphQLField(
            model_type,
            args={"id": GraphQLArgument(GraphQLNonNull(GraphQLID))},
            resolve=resolve_with_override(f"Query.get_{name}", _make_get(store, name, id_field)),
        )
        query_fields[f"list_{name}"] = GraphQLField(
            GraphQLNonNull(GraphQLList(GraphQLNonNull(model_type))),
            args={
                "condition": GraphQLArgument(GraphQLJSON),
                "sort": GraphQLArgument(GraphQLJSON),
                "limit": GraphQLArgument(GraphQLInt),
            },
            resolve=resolve_with_override(f"Query.list_{name}", _make_list(store, name)),
        )
        if not xg.get("readonly"):  # spec/03 钩子 1：模型级 readonly → 只出 Query
            mutation_fields[f"create_{name}"] = GraphQLField(
                model_type,
                args={"input": GraphQLArgument(GraphQLNonNull(GraphQLJSON))},
                resolve=resolve_with_override(
                    f"Mutation.create_{name}", _make_create(store, name)
                ),
            )
            mutation_fields[f"update_{name}"] = GraphQLField(
                model_type,
                args={
                    "id": GraphQLArgument(GraphQLNonNull(GraphQLID)),
                    "set": GraphQLArgument(GraphQLNonNull(GraphQLJSON)),
                },
                resolve=resolve_with_override(
                    f"Mutation.update_{name}", _make_update(store, name, id_field)
                ),
            )
            mutation_fields[f"delete_{name}"] = GraphQLField(
                GraphQLNonNull(GraphQLBoolean),
                args={"id": GraphQLArgument(GraphQLNonNull(GraphQLID))},
                resolve=resolve_with_override(
                    f"Mutation.delete_{name}", _make_delete(store, name, id_field)
                ),
            )

    # spec/03 钩子 3：extend（SDL 同步追加）
    for key, fields in extensions.items():
        if key == "Query":
            query_fields.update(fields)
        elif key == "Mutation":
            mutation_fields.update(fields)
        else:
            raise ValueError(f'extensions 仅支持 Query/Mutation，收到 "{key}"（spec/03）')

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


# ── spec/04：HTTP 承载（FastAPI，可选依赖）──


def create_app(
    store,
    *,
    schema=None,
    context_provider=None,
    permission_error=None,
    resources=None,
    overrides=None,
    extensions=None,
    id_field="_id",
):
    try:
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
    except ImportError as e:  # noqa: F841 — 报错信息自身已含原因
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
    )
    if permission_error is None:
        permission_error = getattr(store, "PermissionError", None)

    @app.post("/graphql")
    async def graphql_endpoint(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 — 非 JSON 请求体按 400 明确反馈，不静默
            return JSONResponse(
                status_code=400, content={"errors": [{"message": "请求体必须是 JSON"}]}
            )
        if context_provider is not None:
            try:
                ctx = context_provider(request)
                if inspect.isawaitable(ctx):
                    ctx = await ctx
            except Exception as e:  # noqa: BLE001 — spec/04：权限类 ⇒ 403；其余 ⇒ 401
                status = 403 if (permission_error and isinstance(e, permission_error)) else 401
                return JSONResponse(
                    status_code=status,
                    content={"errors": [{"message": str(e) or "CONTEXT_ERROR"}]},
                )
            # spec/04：None 同样显式注入（清除语义必须落地，防身份跨请求残留）
            store.set_context(ctx)
        result = await graphql(
            gql_schema,
            body.get("query") or "",
            variable_values=body.get("variables"),
            operation_name=body.get("operationName"),
        )
        payload = {"data": result.data}
        if result.errors:
            payload["errors"] = [e.formatted for e in result.errors]
        return JSONResponse(payload)

    return app
