"""冒烟测试 — mock store(不连真实库,不依赖 rust core 绑定)。

用例语义与 ../../conformance/cases/users-graphql.json 及 node 端 smoke.test.js 对齐。
"""

import asyncio

import pytest
from graphql import GraphQLBoolean, GraphQLField, graphql

from store_graphql import build_graphql_schema, export_sdl, filter_archived

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


def test_filter_archived():
    assert filter_archived(["User", "UserDeleted", "Log"]) == ["User", "Log"]


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
    assert store.gql_log[-1]["gql"] == "User { name, name }"


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
