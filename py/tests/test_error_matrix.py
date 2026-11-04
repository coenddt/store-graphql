"""映射矩阵：每档上下文错误语义 → GraphQL HTTP 状态码（A3「可程序化区分」验收）。

走 create_app 包装层（context_provider 抛错分类），无需真实库；用例与 node/test/error-matrix.test.js 同构。
规范依据：spec/04-errors-context.md（权限类含 NoContext ⇒ 403；其余 ⇒ 401）。
"""

from fastapi.testclient import TestClient

from store_graphql import create_app


class _PermissionError(Exception):
    """store 权限错误类（按类型判定，禁按 message 匹配）。"""


_DEFN = {"name": "User", "fields": {"_id": {"type": "string"}}}


class _Store:
    PermissionError = _PermissionError

    def list(self):
        return ["User"]

    def get(self, _name):
        return _DEFN

    def set_context(self, _ctx):
        pass

    async def query(self, gql, params=None):
        return []


def _provider(request):
    user = request.headers.get("x-user")
    if user == "perm":
        raise _PermissionError("ERR_PERMISSION:无访问权限")
    if user == "nocontext":
        e = RuntimeError("上下文缺失")
        e.code = "no_context"
        raise e
    if user == "broken":
        raise RuntimeError("上下文钩子故障")
    return {"user": user}


def _post(client, user):
    return client.post(
        "/graphql",
        content='{"query":"{ __typename }"}',
        headers={"x-user": user, "Content-Type": "application/json"},
    )


def test_error_matrix_context_tiers_to_status():
    client = TestClient(create_app(_Store(), context_provider=_provider))
    assert _post(client, "perm").status_code == 403
    assert _post(client, "nocontext").status_code == 403
    assert _post(client, "broken").status_code == 401
    assert _post(client, "alice").status_code == 200


class _NotFoundStore(_Store):
    async def query(self, gql, params=None):
        raise RuntimeError(
            "ERR_NOT_FOUND:目标记录不存在（写条件未命中任何行，_id 不存在或已被删除）"
        )


class _PermissionStore(_Store):
    async def query(self, gql, params=None):
        raise _PermissionError("ERR_PERMISSION:RBAC:无权写入")


def _query_client(store):
    return TestClient(create_app(store, context_provider=lambda _r: {"user": "u1"}))


def test_non_permission_err_prefix_maps_to_extensions_code():
    res = _query_client(_NotFoundStore()).post(
        "/graphql", json={"query": "{ listUser { _id } }"}
    )
    assert res.status_code == 200
    err = res.json()["errors"][0]
    assert err["extensions"]["code"] == "NOT_FOUND"
    assert err["message"].startswith("ERR_NOT_FOUND:")


def test_permission_error_keeps_original_message_without_code_rewrite():
    res = _query_client(_PermissionStore()).post(
        "/graphql", json={"query": "{ listUser { _id } }"}
    )
    err = res.json()["errors"][0]
    assert err["message"] == "ERR_PERMISSION:RBAC:无权写入"
    assert "code" not in (err.get("extensions") or {})