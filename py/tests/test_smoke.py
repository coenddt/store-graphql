"""冒烟测试 — mock store(不连真实库,不依赖 rust core 绑定)。

用例语义与 ../../conformance/cases/users-graphql.json 及 node 端 smoke.test.js 对齐。
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "py-store" / "src"))

import pytest
from graphql import GraphQLBoolean, GraphQLField, graphql

from store_graphql import build_graphql_schema, create_app, export_sdl, filter_archived

DEFN = {
    "name": "User",
    "description": "用户表：平台账号主档",
    "fields": {
        "_id": {"type": "string", "description": "主键，u 前缀"},
        "name": {"type": "string"},
        "age": {"type": "int"},
        "profile": {
            "type": "object",
            "description": "个人资料",
            "fields": {"bio": {"type": "string"}},
        },
    },
}


class MockStore:
    def __init__(self):
        self.rows = []
        self.gql_log = []

    def list(self):
        return ["User"]

    def get(self, _name):
        return DEFN

    async def query(self, gql, params=None):
        self.gql_log.append({"gql": gql, "params": params})
        cond = (params or {}).get("c0")
        return [
            r
            for r in self.rows
            if not cond or all(r.get(k) == v for k, v in cond.items())
        ]

    async def insert(self, _name, data):
        doc = {"_id": f"u{len(self.rows) + 1}", **data}
        self.rows.append(doc)
        return doc

    async def update(self, _name, cond, data):
        row = next(r for r in self.rows if all(r.get(k) == v for k, v in cond.items()))
        row.update(data)
        return row

    async def remove(self, _name, cond):
        self.rows = [r for r in self.rows if not all(r.get(k) == v for k, v in cond.items())]

    def set_context(self, _ctx):
        pass


async def run(schema, query, variable_values=None):
    result = await graphql(schema, query, variable_values=variable_values)
    if result.errors:
        raise AssertionError(f"GraphQL 执行失败: {[e.message for e in result.errors]}")
    return result.data


def test_secure_config_guard():
    """fail-secure 装配守卫：require_context=True 且无 context_provider ⇒ ERR_SECURE_CONFIG（先于 fastapi 加载）"""
    closed = MockStore()
    closed.require_context = lambda: True
    # 无 context_provider：守卫在 import fastapi 之前抛错（fail-fast，无额外依赖）
    with pytest.raises(RuntimeError, match="ERR_SECURE_CONFIG"):
        create_app(closed)
    # 补配 context_provider：越过守卫（是否缺 fastapi 由环境决定，但不再是配置错误）
    try:
        create_app(closed, context_provider=lambda request: {"uid": "u1"})
    except RuntimeError as e:
        assert "ERR_SECURE_CONFIG" not in str(e)
    # 默认姿态 require_context=False：守卫不触发
    opened = MockStore()
    opened.require_context = lambda: False
    try:
        create_app(opened)
    except RuntimeError as e:
        assert "ERR_SECURE_CONFIG" not in str(e)


def test_filter_archived():
    assert filter_archived(["User", "UserDeleted", "Log"]) == ["User", "Log"]


def test_schema_filters_reserved_builtin_models():
    store = MockStore()
    store.list = lambda: ["User", "UserDeleted", "__workflowRun", "__feedback"]
    schema = build_graphql_schema(store)
    assert schema.get_type("User") is not None
    assert schema.get_type("__workflowRun") is None
    assert schema.get_type("__feedback") is None
    assert "list___workflowRun" not in schema.get_type("Query").fields


def test_sdl_generation():
    sdl = export_sdl(build_graphql_schema(MockStore()))
    assert "type User {" in sdl
    assert "get_User(id: ID!): User" in sdl
    assert "list_User(condition: JSON, sort: JSON, limit: Int): [User!]!" in sdl
    assert "create_User(input: JSON!): User" in sdl
    assert "profile: User_profile" in sdl
    # description 管道（spec/05）：模型/字段/嵌套类型三层透传
    assert '"""用户表：平台账号主档"""' in sdl
    assert '"""主键，u 前缀"""' in sdl
    assert '"""个人资料"""' in sdl
    assert "SecretLog" not in sdl


def test_create_list_pushdown():
    store = MockStore()
    schema = build_graphql_schema(store)
    created = asyncio.run(
        run(
            schema,
            "mutation($input: JSON!) { create_User(input: $input) { _id name age } }",
            {"input": {"name": "a", "age": 1}},
        )
    )
    assert created["create_User"]["name"] == "a"

    listed = asyncio.run(
        run(
            schema,
            "query($c: JSON, $l: Int) { list_User(condition: $c, limit: $l) { name profile { bio } } }",
            {"c": {"name": "a"}, "l": 10},
        )
    )
    assert len(listed["list_User"]) == 1
    assert listed["list_User"][0]["name"] == "a"

    # 投影下推断言:selection 编入 GQL 串,参数按需拼接(spec/02 映射表)
    last = store.gql_log[-1]
    assert last["gql"] == "User($condition:@c0,$limit:@l) { name, profile { bio } }"
    assert last["params"] == {"c0": {"name": "a"}, "l": 10}


def test_get_update_delete():
    store = MockStore()
    schema = build_graphql_schema(store)
    asyncio.run(
        run(schema, "mutation($i: JSON!) { create_User(input: $i) { _id } }", {"i": {"name": "b"}})
    )

    got = asyncio.run(run(schema, '{ get_User(id: "u1") { name } }'))
    assert got["get_User"]["name"] == "b"

    updated = asyncio.run(
        run(
            schema,
            "mutation($id: ID!, $set: JSON!) { update_User(id: $id, set: $set) { name age } }",
            {"id": "u1", "set": {"age": 2}},
        )
    )
    assert updated["update_User"]["age"] == 2

    deleted = asyncio.run(run(schema, 'mutation { delete_User(id: "u1") }'))
    assert deleted["delete_User"] is True
    listed = asyncio.run(run(schema, "{ list_User { _id } }"))
    assert listed["list_User"] == []


def test_skip_and_fragment():
    store = MockStore()
    schema = build_graphql_schema(store)
    asyncio.run(
        run(schema, "mutation($i: JSON!) { create_User(input: $i) { _id } }", {"i": {"name": "c"}})
    )
    asyncio.run(
        run(
            schema,
            "query($noAge: Boolean!) { list_User { name age @skip(if: $noAge) ...U } }"
            "fragment U on User { name }",
            {"noAge": True},
        )
    )
    assert store.gql_log[-1]["gql"] == "User($limit:@l) { name, name }"


def test_limit_guard():
    # spec/02:缺省 50 / 超限 ERR_LIMIT: / 边界 1000
    store = MockStore()
    schema = build_graphql_schema(store)
    asyncio.run(run(schema, "{ list_User { _id } }"))
    last = store.gql_log[-1]
    assert last["gql"] == "User($limit:@l) { _id }"
    assert last["params"]["l"] == 50

    asyncio.run(run(schema, "query($l: Int) { list_User(limit: $l) { _id } }", {"l": 1000}))
    assert store.gql_log[-1]["params"]["l"] == 1000

    result = asyncio.run(
        graphql(schema, "query($l: Int) { list_User(limit: $l) { _id } }", variable_values={"l": 1001})
    )
    assert result.errors and "ERR_LIMIT:" in result.errors[0].message
    assert result.data is None  # list_User 非空 ⇒ 错误冒泡至根,data 整体为 None


def test_annotations_hidden_readonly():
    store = MockStore()
    hidden = {**DEFN, "name": "SecretLog", "x-graphql": {"hidden": True}}
    readonly = {**DEFN, "name": "AuditEvent", "x-graphql": {"readonly": True}}
    store.list = lambda: ["User", "SecretLog", "AuditEvent"]
    store.get = lambda n: {"User": DEFN, "SecretLog": hidden, "AuditEvent": readonly}[n]
    sdl = export_sdl(build_graphql_schema(store))
    assert "SecretLog" not in sdl
    assert "get_AuditEvent" in sdl
    assert "create_AuditEvent" not in sdl


def test_graphiql_page():
    # spec/05：GET /graphql 返回 GraphiQL 文档页
    from fastapi.testclient import TestClient

    from store_graphql import create_app

    client = TestClient(create_app(MockStore()))
    resp = client.get("/graphql")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "graphiql" in resp.text.lower()


class _PermissionError(Exception):
    """模拟 store.PermissionError（RBAC 拒绝）。"""


def test_security_matrix():
    # spec/04 安全矩阵：403/401 分类、400 非 JSON、413 体限
    from fastapi.testclient import TestClient

    from store_graphql import create_app

    store = MockStore()
    store.PermissionError = _PermissionError

    def provider(request):
        user = request.headers.get("x-user")
        if user == "bad":
            raise _PermissionError("ERR_PERMISSION:无访问权限")
        if user == "broken":
            raise RuntimeError("上下文钩子故障")
        return {"user": user}

    client = TestClient(create_app(store, context_provider=provider))
    post = lambda u, body, **kw: client.post(  # noqa: E731
        "/graphql", content=body, headers={"x-user": u, "Content-Type": "application/json"}, **kw
    )

    assert post("bad", '{"query":"{ __typename }"}').status_code == 403
    assert post("broken", '{"query":"{ __typename }"}').status_code == 401
    assert post("alice", "not-json").status_code == 400
    assert post("alice", '{"query":"' + "x" * ((1 << 20) + 10) + '"}').status_code == 413
    ok = post("alice", '{"query":"{ __typename }"}')
    assert ok.status_code == 200
    assert ok.json()["data"]["__typename"] == "Query"


def test_query_depth_guard():
    # spec/04:深度算法单元 + HTTP 层小阈值 400
    from graphql import parse

    from store_graphql.adapter import MAX_QUERY_DEPTH, query_depth

    deep = "{ " + "a { " * 10 + "x " + "}" * 10 + " }"
    assert MAX_QUERY_DEPTH == 10
    assert query_depth(parse(deep)) == 11
    assert query_depth(parse("{ list_User { _id } }")) == 2
    # fragment 深度计入(非环)+ 环引用给有限值不崩
    assert query_depth(parse("query { ...A } fragment A on Query { list_User { _id } }")) == 2
    assert query_depth(parse("query { ...A } fragment A on Query { list_User { ...A } }")) == 1

    from fastapi.testclient import TestClient

    from store_graphql import create_app

    client = TestClient(create_app(MockStore(), max_query_depth=2))
    ok = client.post("/graphql", json={"query": "{ list_User { _id } }"})
    assert ok.status_code == 200
    deep3 = client.post("/graphql", json={"query": "{ list_User { profile { bio } } }"})
    assert deep3.status_code == 400
    assert "ERR_DEPTH:" in deep3.json()["errors"][0]["message"]


def test_complexity_and_introspection_guard():
    # spec/04:字段计数单元 + max_query_fields 超限 + introspection 开关
    from graphql import parse

    from store_graphql.adapter import query_field_count

    assert query_field_count(parse("{ list_User { _id } }"))["fields"] == 2
    assert query_field_count(parse("{ __schema { queryType { name } } }"))["introspection_used"] is True

    from fastapi.testclient import TestClient

    from store_graphql import create_app

    client = TestClient(create_app(MockStore(), max_query_fields=2, introspection=False))
    post = lambda q: client.post("/graphql", json={"query": q})  # noqa: E731

    assert post("{ list_User { _id } }").status_code == 200
    over = post("{ list_User { _id name } }")
    assert over.status_code == 400 and "ERR_COMPLEXITY:" in over.json()["errors"][0]["message"]
    assert post("{ __typename }").status_code == 200
    intro = post("{ __schema { queryType { name } } }")
    assert intro.status_code == 400 and "ERR_INTROSPECTION:" in intro.json()["errors"][0]["message"]


def test_override_and_extend():
    store = MockStore()

    async def override_list(_src, _info, **_args):
        return [{"_id": "x", "name": "override", "age": 0, "profile": None}]

    schema = build_graphql_schema(
        store,
        overrides={"Query.list_User": override_list},
        extensions={"Query": {"ping": GraphQLField(GraphQLBoolean, resolve=lambda *_a: True)}},
    )
    data = asyncio.run(run(schema, "{ list_User { name } ping }"))
    assert data["list_User"][0]["name"] == "override"
    assert data["ping"] is True

    with pytest.raises(ValueError, match="未命中"):
        build_graphql_schema(store, overrides={"Query.list_Nope": override_list})


# ── R2-04：policy_provider 请求入口作用域化（与 store-api/py/tests 同构，双端 parity）──


def test_policy_provider_guard_and_require_context():
    """R2-04：装配守卫 + requireContext 覆盖；无 ctx 请求 → no_context；返回 None → 行为同现状"""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient
    from py_store import current_scope

    # 装配守卫：宿主未导出 base_view() 时注入 policy_provider ⇒ 装配期显式失败（fail-fast，禁静默降级）
    with pytest.raises(RuntimeError, match="ERR_POLICY_PROVIDER_CONFIG"):
        create_app(MockStore(), policy_provider=lambda ctx: None)

    store = MockStore()
    store.base_view = lambda: SimpleNamespace(with_policy=lambda o: {"overrides": o})
    store.last_context = None

    def _set_context(ctx):
        store.last_context = ctx

    store.set_context = _set_context

    # 作用域感知的 query（模拟宿主 fail-secure：视图要求 ctx 且当前 ctx 缺失 ⇒ NoContext）
    async def scoped_query(_gql, _params=None):
        scope = current_scope()
        view = scope.view if scope else None
        if (
            view
            and view.get("overrides", {}).get("requireContext")
            and store.last_context is None
        ):
            e = RuntimeError("ERR_NO_CONTEXT:上下文缺失")
            e.code = "no_context"
            raise e
        return list(store.rows)

    store.query = scoped_query

    # ① 注入 requireContext 覆盖：未配 context_provider（policy_provider 收到 None）
    seen = []

    def policy(ctx):
        seen.append(ctx)
        return {"requireContext": True}

    client = TestClient(create_app(store, policy_provider=policy))
    denied = client.post("/graphql", json={"query": "{ list_User { _id } }"})
    assert seen == [None]  # policy_provider 入参 = 已解析 ctx（无 context_provider ⇒ None）
    assert denied.json()["data"] is None
    assert denied.json()["errors"][0]["message"].startswith("ERR_NO_CONTEXT")

    # ② 注入返回 None ⇒ 无视图作用域（current_scope() 为 None）→ 行为同现状
    lax = TestClient(create_app(store, policy_provider=lambda ctx: None))
    ok = lax.post("/graphql", json={"query": "{ list_User { _id } }"})
    assert ok.status_code == 200
    assert "errors" not in ok.json()


def test_policy_provider_profile_view_and_ctx_reuse():
    """R2-04：profile 覆盖经视图生效（查询面可观察）；ctx 复用自 context_provider（禁二次调用）"""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient
    from py_store import current_scope

    store = MockStore()
    store.base_view = lambda: SimpleNamespace(with_policy=lambda o: {"overrides": o})

    # 档位判决可观察面：text2query 档视图下输出收缩（模拟 core 判决差异经宿主查询面可见）
    async def scoped_query(_gql, _params=None):
        scope = current_scope()
        view = scope.view if scope else None
        if view and view.get("overrides", {}).get("profile") == "text2query":
            return [{"_id": "r1", "name": "redacted"}]
        return list(store.rows)

    store.query = scoped_query

    ctx_calls = []

    def context_provider(_request):
        ctx_calls.append(1)
        return {"uid": "u9"}

    def policy(ctx):
        return {"profile": "text2query"} if ctx and ctx.get("uid") == "u9" else None

    client = TestClient(
        create_app(store, context_provider=context_provider, policy_provider=policy)
    )
    res = client.post("/graphql", json={"query": "{ list_User { _id name } }"})
    assert res.status_code == 200
    assert res.json()["data"]["list_User"] == [{"_id": "r1", "name": "redacted"}]
    # 单请求 context_provider 恰好解析一次（handler 层已解析值复用，禁二次调用）
    assert len(ctx_calls) == 1
