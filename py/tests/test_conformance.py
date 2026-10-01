"""conformance runner — 直接消费 ../../conformance/cases/*.json 执行断言。

三端 runner 同构:同一份用例,同一套 expect 契约(dataKeys/gql/paramsLimit/errorCodePrefix)。
语义变更必须先改 spec/,再改 cases/,再三端 runner——三者不一致即为缺陷。
"""

import asyncio
import json
from pathlib import Path

from graphql import execute as gql_execute, parse

from store_graphql import build_graphql_schema

CASE = json.loads(
    (Path(__file__).resolve().parents[2] / "conformance" / "cases" / "users-graphql.json").read_text(
        encoding="utf-8"
    )
)


class CaseStore:
    def __init__(self, schema_defn):
        self.defn = schema_defn
        self.rows = []
        self.gql_log = []

    def list(self):
        return [self.defn["name"]]

    def get(self, _name):
        return self.defn

    async def query(self, gql, params=None):
        self.gql_log.append({"gql": gql, "params": params})
        cond = (params or {}).get("c0")
        return [r for r in self.rows if not cond or all(r.get(k) == v for k, v in cond.items())]

    async def insert(self, _name, data):
        doc = {"_id": "u1", **data}
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


def test_conformance():
    store = CaseStore(CASE["schema"])
    schema = build_graphql_schema(store)

    async def run_step(step):
        result = await gql_execute(
            schema, parse(step["query"]), variable_values=step.get("variables") or {}
        )
        return result

    async def run_all():
        for i, step in enumerate(CASE["steps"]):
            result = await run_step(step)
            expect = step["expect"]
            errors = result.errors or ()
            if expect.get("errorCodePrefix"):
                assert errors, f"step#{i} 应抛 {expect['errorCodePrefix']}"
                assert errors[0].message.startswith(expect["errorCodePrefix"]), (
                    f"step#{i} 错误前缀不符: {errors[0].message}"
                )
                continue
            assert not errors, f"step#{i} 不应有错误: {[e.message for e in errors]}"
            data = result.data or {}
            for key in expect.get("dataKeys") or []:
                assert key in data, f"step#{i} data 缺少 {key}"
            if "gql" in expect:
                assert store.gql_log[-1]["gql"] == expect["gql"], f"step#{i} 投影下推串不符"
            if "paramsLimit" in expect:
                assert store.gql_log[-1]["params"]["l"] == expect["paramsLimit"], (
                    f"step#{i} params.l 不符"
                )

    asyncio.run(run_all())
