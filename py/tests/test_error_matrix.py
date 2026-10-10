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