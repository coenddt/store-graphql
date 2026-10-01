package storegraphql

// e2e(真实库)— go-store(真实 rust core FFI)+ SQLite 内存库跑 GraphQL 全链路。
//
// 验证点:适配层契约与投影下推串被真实 core 接受、CRUD 全链路真实落库(含归档编排)。
// rust_store_ffi.dll 缺失 ⇒ t.Skip 显式标注(不静默);dll 候选路径见 go-store/ffi.go。
//
// 真实契约点(与 node/py 端 e2e 同款):
// - go-store 是数据层,EnsureTables/CreateTableStatements 出 DDL 由应用执行
// - 归档表 UserDeleted 由 core 自动注册(Register 即注册),remove 的归档编排需要其表

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	gostore "github.com/coenddt/go-store"
	"github.com/graphql-go/graphql"
)

const e2eDefnJSON = `{
	"name": "User",
	"collection": "users",
	"idPrefix": "u",
	"fields": {
		"_id": {"type": "string"},
		"name": {"type": "string"},
		"age": {"type": "int"}
	}
}`

func numEq(v interface{}, want float64) bool {
	switch n := v.(type) {
	case int:
		return float64(n) == want
	case float64:
		return n == want
	}
	return false
}

func TestE2ERealSQLite(t *testing.T) {
	st, err := gostore.Open("sqlite::memory:")
	if err != nil {
		t.Skipf("rust core FFI 不可用(rust-store/target/release/rust_store_ffi.dll 缺失?): %v", err)
	}
	defer st.Close()

	var defn map[string]any
	if err := json.Unmarshal([]byte(e2eDefnJSON), &defn); err != nil {
		t.Fatalf("defn 解析失败: %v", err)
	}
	if err := st.Register(defn); err != nil {
		t.Fatalf("Register 失败: %v", err)
	}
	// go-store 是数据层,EnsureTables 落 DDL(含自动注册的归档表 UserDeleted)
	if err := st.EnsureTables(defn); err != nil {
		t.Fatalf("EnsureTables 失败: %v", err)
	}

	schema, err := Build(st, Options{Schemas: []map[string]any{defn}})
	if err != nil {
		t.Fatalf("Build 失败: %v", err)
	}
	do := func(query string, vars map[string]interface{}) *graphql.Result {
		return graphql.Do(graphql.Params{
			Schema:         schema,
			Context:        context.Background(),
			RequestString:  query,
			VariableValues: vars,
		})
	}

	// create:真实 core 生成 _id、真实落库(JSON 一律走 variables,spec/02:go 端内联字面量被拒)
	created := do(`mutation($input: JSON!) { create_User(input: $input) { _id name age } }`,
		map[string]interface{}{"input": map[string]interface{}{"name": "alice", "age": 30}})
	if created.HasErrors() {
		t.Fatalf("create 失败: %v", created.Errors)
	}
	doc := created.Data.(map[string]interface{})["create_User"].(map[string]interface{})
	realID, _ := doc["_id"].(string)
	if !strings.HasPrefix(realID, "u") {
		t.Fatalf("应返回 u 前缀真实 _id,实际 %v", doc["_id"])
	}

	// list:投影下推串经真实 core 解析并走 SQLite
	listed := do(`{ list_User { _id name } }`, nil)
	if listed.HasErrors() {
		t.Fatalf("list 失败: %v", listed.Errors)
	}
	rows := listed.Data.(map[string]interface{})["list_User"].([]interface{})
	if len(rows) != 1 || rows[0].(map[string]interface{})["name"] != "alice" {
		t.Fatalf("list 应命中 1 行 alice,实际 %v", rows)
	}

	// get:条件投影
	got := do(fmt.Sprintf(`{ get_User(id: %q) { name age } }`, realID), nil)
	if got.HasErrors() {
		t.Fatalf("get 失败: %v", got.Errors)
	}
	g := got.Data.(map[string]interface{})["get_User"].(map[string]interface{})
	if g["name"] != "alice" || !numEq(g["age"], 30) {
		t.Fatalf("get 回读不符: %v", g)
	}

	// update:写入 + 回读
	updated := do(`mutation($id: ID!, $set: JSON!) { update_User(id: $id, set: $set) { name age } }`,
		map[string]interface{}{"id": realID, "set": map[string]interface{}{"age": 31}})
	if updated.HasErrors() {
		t.Fatalf("update 失败: %v", updated.Errors)
	}
	u := updated.Data.(map[string]interface{})["update_User"].(map[string]interface{})
	if u["age"] != float64(31) && !numEq(u["age"], 31) {
		t.Fatalf("update 回读不符: %v", u)
	}

	// delete:归档编排后列表为空
	deleted := do(`mutation($id: ID!) { delete_User(id: $id) }`,
		map[string]interface{}{"id": realID})
	if deleted.HasErrors() {
		t.Fatalf("delete 失败: %v", deleted.Errors)
	}
	after := do(`{ list_User { _id } }`, nil)
	rowsAfter := after.Data.(map[string]interface{})["list_User"].([]interface{})
	if len(rowsAfter) != 0 {
		t.Fatalf("delete 后应为空,实际 %v", rowsAfter)
	}
}
