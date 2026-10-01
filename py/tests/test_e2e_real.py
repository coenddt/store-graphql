"""e2e(真实库)— py-store(真实 rust core)+ aiosqlite 内存库跑 GraphQL 全链路。

验证点:适配层契约(store.list()/get() 真实返回结构)、投影下推串被真实 core 接受、
CRUD 全链路真实落库(含归档编排)。依赖缺失 ⇒ pytest.skip 显式标注(不静默)。

真实契约点(与 node 端 e2e 同款,出处见各断言注释):
- SQL 源须传 executors.create_connection('sqlite', db) 描述符,裸传驱动实例被当 Mongo
- py-store 不写 DDL,generate_ddl 纯文本由应用执行(aiosqlite 的 executescript 须 await)
- 归档表 UserDeleted 由 core 自动注册,remove 的归档编排需要其 DDL
"""

import asyncio

import pytest

from store_graphql import build_graphql_schema

pytest.importorskip("py_store", reason="py-store 未安装(pip install -e py-store)")
pytest.importorskip("aiosqlite", reason="aiosqlite 未安装(pip install aiosqlite)")

DEFN = {
    "name": "User",
    "collection": "users",
    "idPrefix": "u",
    "fields": {
        "_id": {"type": "string"},
        "name": {"type": "string"},
        "age": {"type": "int"},
    },
}


async def _run_case():
    import aiosqlite
    import py_store

    async with aiosqlite.connect(":memory:") as db:
        conn = py_store.executors.create_connection("sqlite", db)
        await py_store.init({"default": conn})
        py_store.store.register(DEFN)
        # py-store 不写 DDL;aiosqlite 的 executescript 是协程,必须 await
        await db.executescript(py_store.store.generate_ddl("sqlite", ["User"]))
        await db.executescript(py_store.store.generate_ddl("sqlite", ["UserDeleted"]))

        schema = build_graphql_schema(py_store.store)

        async def run(query, variable_values=None):
            from graphql import parse, execute as gql_execute

            result = await gql_execute(
                schema, parse(query), variable_values=variable_values or {}
            )
            if result.errors:
                raise AssertionError(f"GraphQL 执行失败: {[e.message for e in result.errors]}")
            return result.data

        # create:真实 core 生成 _id + timestamps,真实落库
        created = await run(
            "mutation($input: JSON!) { create_User(input: $input) { _id name age } }",
            {"input": {"name": "alice", "age": 30}},
        )
        real_id = created["create_User"]["_id"]
        assert real_id.startswith("u"), f"应返回真实生成的 u 前缀 _id,实际 {real_id}"

        # list:投影下推串经真实 core 解析并走 SQLite
        listed = await run("{ list_User { _id name } }")
        assert len(listed["list_User"]) == 1
        assert listed["list_User"][0]["name"] == "alice"

        # get:条件投影
        got = await run(f'{{ get_User(id: "{real_id}") {{ name age }} }}')
        assert got["get_User"] == {"name": "alice", "age": 30}

        # update:写入 + 回读
        updated = await run(
            "mutation($id: ID!, $set: JSON!) { update_User(id: $id, set: $set) { name age } }",
            {"id": real_id, "set": {"age": 31}},
        )
        assert updated["update_User"]["age"] == 31

        # delete:归档编排(deletedCount + archivedCount)后列表为空
        deleted = await run(f'mutation {{ delete_User(id: "{real_id}") }}')
        assert deleted["delete_User"] is True
        after = await run("{ list_User { _id } }")
        assert after["list_User"] == []


def test_e2e_real_sqlite():
    asyncio.run(_run_case())
