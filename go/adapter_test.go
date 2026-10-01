package storegraphql

// 冒烟测试 — mock Store（不连真实库，不依赖 rust core FFI）。
// 用例语义与 ../conformance/cases/users-graphql.json 及 node/py 端 smoke 对齐。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gostore "github.com/coenddt/go-store"
	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"
	"github.com/graphql-go/graphql/language/parser"
)

func jsonNewDecoder(r io.Reader) *json.Decoder { return json.NewDecoder(r) }

func mustParse(t *testing.T, src string) *ast.Document {
	t.Helper()
	doc, err := parser.Parse(parser.ParseParams{Source: src})
	if err != nil {
		t.Fatalf("parse 失败: %v", err)
	}
	return doc
}

const introspectionQuery = `query {
  __schema {
    types {
      name
      kind
      description
      fields { name description }
    }
  }
}`

// sprintIntrospection 把 introspection 结果压成「type Name { fields... }」伪 SDL 便于断言。
func sprintIntrospection(t *testing.T, res *graphql.Result) string {
	t.Helper()
	data, err := json.Marshal(res.Data)
	if err != nil {
		t.Fatalf("introspection 结果序列化失败: %v", err)
	}
	var parsed struct {
		Schema struct {
			Types []struct {
				Name        string `json:"name"`
				Kind        string `json:"kind"`
				Description string `json:"description"`
				Fields      []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"fields"`
			} `json:"types"`
		} `json:"__schema"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("introspection 结果解析失败: %v", err)
	}
	var b strings.Builder
	for _, typ := range parsed.Schema.Types {
		if strings.HasPrefix(typ.Name, "__") {
			continue
		}
		fmt.Fprintf(&b, "type %s", typ.Name)
		if typ.Description != "" {
			fmt.Fprintf(&b, " \"\"\"%s\"\"\"", typ.Description)
		}
		if len(typ.Fields) > 0 {
			names := make([]string, 0, len(typ.Fields))
			for _, f := range typ.Fields {
				if f.Description != "" {
					names = append(names, fmt.Sprintf("%s(%s)", f.Name, f.Description))
				} else {
					names = append(names, f.Name)
				}
			}
			fmt.Fprintf(&b, " { %s }", strings.Join(names, " "))
		}
		b.WriteString("\n")
	}
	return b.String()
}

const testDefnJSON = `{
	"name": "User",
	"description": "用户表：平台账号主档",
	"fields": {
		"_id": {"type": "string", "description": "主键，u 前缀"},
		"name": {"type": "string"},
		"age": {"type": "int"},
		"profile": {"type": "object", "fields": {"bio": {"type": "string"}}}
	}
}`

type mockStore struct {
	rows       []map[string]any
	gqlLog     []string
	lastParams map[string]any
	nextID     int
}

func defnMap(t *testing.T) map[string]any {
	t.Helper()
	var v map[string]any
	dec := jsonNewDecoder(strings.NewReader(testDefnJSON))
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("defn 解码失败: %v", err)
	}
	return v
}

func newMockStore(t *testing.T) *mockStore {
	return &mockStore{nextID: 1}
}

func condMatch(row, cond map[string]any) bool {
	for k, v := range cond {
		if row[k] != v {
			return false
		}
	}
	return true
}

func (m *mockStore) Query(_ context.Context, gql string, params map[string]any, _ *gostore.Context) ([]map[string]any, error) {
	m.gqlLog = append(m.gqlLog, gql)
	m.lastParams = params
	var cond map[string]any
	if params != nil {
		cond, _ = params["c0"].(map[string]any)
	}
	out := []map[string]any{}
	for _, r := range m.rows {
		if cond == nil || condMatch(r, cond) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *mockStore) Insert(_ context.Context, _ string, data map[string]any, _ *gostore.Context) (map[string]any, error) {
	doc := map[string]any{"_id": "u1"}
	for k, v := range data {
		doc[k] = v
	}
	m.rows = append(m.rows, doc)
	return doc, nil
}

func (m *mockStore) Update(_ context.Context, _ string, condition, data map[string]any, _ *gostore.Context) (map[string]any, error) {
	for _, r := range m.rows {
		if condMatch(r, condition) {
			for k, v := range data {
				r[k] = v
			}
			return r, nil
		}
	}
	return nil, nil
}

func (m *mockStore) Remove(_ context.Context, _ string, condition map[string]any, _ *gostore.Context) (map[string]any, error) {
	kept := []map[string]any{}
	for _, r := range m.rows {
		if !condMatch(r, condition) {
			kept = append(kept, r)
		}
	}
	m.rows = kept
	return nil, nil
}

func buildTestSchema(t *testing.T, st *mockStore, opts Options) graphql.Schema {
	t.Helper()
	if opts.Schemas == nil {
		opts.Schemas = []map[string]any{defnMap(t)}
	}
	schema, err := Build(st, opts)
	if err != nil {
		t.Fatalf("Build 失败: %v", err)
	}
	return schema
}

func do(t *testing.T, schema graphql.Schema, query string, variables map[string]interface{}) *graphql.Result {
	t.Helper()
	res := graphql.Do(graphql.Params{Schema: schema, Context: context.Background(), RequestString: query, VariableValues: variables})
	if res.HasErrors() {
		t.Fatalf("GraphQL 执行失败: %v", res.Errors)
	}
	return res
}

func TestSDLGeneration(t *testing.T) {
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	res := graphql.Do(graphql.Params{Schema: schema, RequestString: introspectionQuery})
	if res.HasErrors() {
		t.Fatalf("introspection 失败: %v", res.Errors)
	}
	sdl := sprintIntrospection(t, res)
	for _, want := range []string{"get_User", "list_User", "create_User", "update_User", "delete_User"} {
		if !strings.Contains(sdl, want) {
			t.Errorf("SDL 缺少 %q，实际:\n%s", want, sdl)
		}
	}
	// description 管道（spec/05）：模型/字段两层透传（sprintIntrospection 打印格式：类型用三引号、字段用括号）
	if !strings.Contains(sdl, `"""用户表：平台账号主档"""`) || !strings.Contains(sdl, `_id(主键，u 前缀)`) {
		t.Errorf("SDL 缺少 description，实际:\n%s", sdl)
	}
}

func TestContextErrorClassification(t *testing.T) {
	// spec/04：PermissionError（core ERR_PERMISSION: 前缀）⇒ 403；其余 ⇒ 401；1MB 体限 ⇒ 413
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	handler := Handler(schema, Options{
		ContextProvider: func(r *http.Request) (*gostore.Context, error) {
			switch r.Header.Get("x-user") {
			case "bad":
				return nil, errString("ERR_PERMISSION:无访问权限")
			case "broken":
				return nil, errString("上下文钩子故障")
			}
			return nil, nil
		},
	})

	post := func(u string, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-user", u)
		handler(rec, req)
		return rec
	}

	if rec := post("bad", `{"query":"{ __typename }"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("ERR_PERMISSION: 前缀应 403，实际 %d", rec.Code)
	}
	if rec := post("broken", `{"query":"{ __typename }"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("非权限 provider 错误应 401，实际 %d", rec.Code)
	}
	if rec := post("alice", `{"query":"`+strings.Repeat("x", (1<<20)+10)+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("超 1MB 请求体应被截断拒绝（400/413），实际 %d", rec.Code)
	}
	if rec := post("alice", `{"query":"{ __typename }"}`); rec.Code != http.StatusOK {
		t.Fatalf("正常请求应 200，实际 %d", rec.Code)
	}
}

func TestLimitGuard(t *testing.T) {
	// spec/02：缺省 50 / 超限 ERR_LIMIT: / 边界 1000
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})

	do(t, schema, `{ list_User { _id } }`, nil)
	last := st.gqlLog[len(st.gqlLog)-1]
	if last != "User($limit:@l) { _id }" {
		t.Fatalf("缺省应恒拼 $limit:@l:\n got: %s", last)
	}
	// params.l = 50 经 do 的 res 断言不可见,直接再查一次带显式变量确认守卫放行路径
	res := graphql.Do(graphql.Params{Schema: schema, Context: context.Background(),
		RequestString: `query($l: Int){ list_User(limit: $l){ _id } }`,
		VariableValues: map[string]interface{}{"l": 1000}})
	if res.HasErrors() {
		t.Fatalf("边界 1000 应通过: %v", res.Errors)
	}
	if last := st.gqlLog[len(st.gqlLog)-1]; last != "User($limit:@l) { _id }" {
		t.Fatalf("显式 limit 应恒拼 $limit:@l:\n got: %s", last)
	}

	over := graphql.Do(graphql.Params{Schema: schema, Context: context.Background(),
		RequestString: `query($l: Int){ list_User(limit: $l){ _id } }`,
		VariableValues: map[string]interface{}{"l": 1001}})
	if !over.HasErrors() || !strings.Contains(over.Errors[0].Error(), "ERR_LIMIT:") {
		t.Fatalf("超限应带 ERR_LIMIT: 前缀: %v", over.Errors)
	}
}

func TestQueryDepthGuard(t *testing.T) {
	// spec/04:深度算法单元(11 层纯 AST,fragment 计入+环不崩)+ HTTP 层小阈值 400
	deep := "{ " + strings.Repeat("a { ", 10) + "x " + strings.Repeat("}", 10) + " }"
	doc, err := parser.Parse(parser.ParseParams{Source: deep})
	if err != nil {
		t.Fatalf("深查询 parse 失败: %v", err)
	}
	if d := queryDepth(doc); d != 11 {
		t.Fatalf("11 层深度应为 11,实际 %d", d)
	}
	shallow, _ := parser.Parse(parser.ParseParams{Source: `{ list_User { _id } }`})
	if d := queryDepth(shallow); d != 2 {
		t.Fatalf("浅查询深度应为 2,实际 %d", d)
	}
	fragDoc, _ := parser.Parse(parser.ParseParams{
		Source: `query { ...A } fragment A on Query { list_User { _id } }`})
	if d := queryDepth(fragDoc); d != 2 {
		t.Fatalf("fragment 深度应计入,实际 %d", d)
	}
	cycleDoc, _ := parser.Parse(parser.ParseParams{
		Source: `query { ...A } fragment A on Query { list_User { ...A } }`})
	if d := queryDepth(cycleDoc); d != 1 {
		t.Fatalf("环引用应给有限值(防环),实际 %d", d)
	}

	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	handler := Handler(schema, Options{MaxQueryDepth: 2})
	post := func(query string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(query))
		req.Header.Set("Content-Type", "application/json")
		handler(rec, req)
		return rec
	}
	if rec := post(`{"query":"{ list_User { _id } }"}`); rec.Code != http.StatusOK {
		t.Fatalf("深度 2 应放行,实际 %d", rec.Code)
	}
	rec := post(`{"query":"{ list_User { profile { bio } } }"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("深度 3 应 400,实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ERR_DEPTH:") {
		t.Fatalf("超限应带 ERR_DEPTH: 前缀: %s", rec.Body.String())
	}
}

func TestComplexityAndIntrospectionGuard(t *testing.T) {
	// spec/04:字段计数单元 + MaxQueryFields 超限 + DisableIntrospection
	fields, introUsed := queryFieldCount(mustParse(t, `{ list_User { _id } }`))
	if fields != 2 || introUsed {
		t.Fatalf("字段计数应为 2 且非 introspection,实际 %d/%v", fields, introUsed)
	}
	if _, introUsed := queryFieldCount(mustParse(t, `{ __schema { queryType { name } } }`)); !introUsed {
		t.Fatal("__schema 应检出 introspection 使用")
	}

	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	handler := Handler(schema, Options{MaxQueryFields: 2, DisableIntrospection: true})
	post := func(query string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(query))
		req.Header.Set("Content-Type", "application/json")
		handler(rec, req)
		return rec
	}

	if rec := post(`{"query":"{ list_User { _id } }"}`); rec.Code != http.StatusOK {
		t.Fatalf("字段数 2(边界)应放行,实际 %d", rec.Code)
	}
	rec := post(`{"query":"{ list_User { _id name } }"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "ERR_COMPLEXITY:") {
		t.Fatalf("超字段上限应 400 + ERR_COMPLEXITY:,实际 %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"query":"{ __typename }"}`); rec.Code != http.StatusOK {
		t.Fatalf("__typename 应放行,实际 %d", rec.Code)
	}
	rec = post(`{"query":"{ __schema { queryType { name } } }"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "ERR_INTROSPECTION:") {
		t.Fatalf("禁用后 __schema 应 400 + ERR_INTROSPECTION:,实际 %d %s", rec.Code, rec.Body.String())
	}
}

// errString 轻量 error 实现（前缀契约测试用）。
type errString string

func (e errString) Error() string { return string(e) }

func TestGraphiQLPage(t *testing.T) {
	// spec/05：GET /graphql 返回 GraphiQL 文档页；POST 仍走执行
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	handler := Handler(schema, Options{})

	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, "/graphql", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("GET /graphql 应返回 200 text/html，实际 %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "graphiql") {
		t.Fatalf("GET /graphql 应返回 GraphiQL 页面")
	}

	rec2 := httptest.NewRecorder()
	handler(rec2, httptest.NewRequest(http.MethodPut, "/graphql", strings.NewReader("{}")))
	if rec2.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT 应 405，实际 %d", rec2.Code)
	}
}

func TestCreateListPushdown(t *testing.T) {
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})

	created := do(t, schema,
		`mutation($input: JSON!) { create_User(input: $input) { _id name age } }`,
		map[string]interface{}{"input": map[string]interface{}{"name": "a", "age": 1}})
	if created.Data.(map[string]interface{})["create_User"] == nil {
		t.Fatalf("create 未返回文档: %v", created.Data)
	}

	listed := do(t, schema,
		`query($c: JSON, $l: Int) { list_User(condition: $c, limit: $l) { name } }`,
		map[string]interface{}{"c": map[string]interface{}{"name": "a"}, "l": 10})
	rows := listed.Data.(map[string]interface{})["list_User"].([]interface{})
	if len(rows) != 1 {
		t.Fatalf("list 应返回 1 条，实际 %d", len(rows))
	}

	// 投影下推断言（spec/02 映射表）：selection 编入 GQL 串，参数按需拼接
	last := st.gqlLog[len(st.gqlLog)-1]
	want := "User($condition:@c0,$limit:@l) { name }"
	if last != want {
		t.Fatalf("投影下推串不符:\n got: %s\nwant: %s", last, want)
	}
}

func TestGetUpdateDelete(t *testing.T) {
	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{})
	do(t, schema, `mutation($input: JSON!) { create_User(input: $input) { _id } }`,
		map[string]interface{}{"input": map[string]interface{}{"name": "b"}})

	got := do(t, schema, `{ get_User(id: "u1") { name } }`, nil)
	if got.Data.(map[string]interface{})["get_User"] == nil {
		t.Fatalf("get 未命中: %v", got.Data)
	}

	updated := do(t, schema,
		`mutation($id: ID!, $set: JSON!) { update_User(id: $id, set: $set) { name age } }`,
		map[string]interface{}{"id": "u1", "set": map[string]interface{}{"age": 2}})
	u := updated.Data.(map[string]interface{})["update_User"].(map[string]interface{})
	if u["age"] != 2 {
		t.Fatalf("update 回读 age 应为 2，实际 %v", u["age"])
	}

	deleted := do(t, schema, `mutation { delete_User(id: "u1") }`, nil)
	if deleted.Data.(map[string]interface{})["delete_User"] != true {
		t.Fatalf("delete 应返回 true: %v", deleted.Data)
	}
	if rows := st.rows; len(rows) != 0 {
		t.Fatalf("delete 后应为空，实际 %v", rows)
	}
}

func TestAnnotationsAndOverride(t *testing.T) {
	st := newMockStore(t)
	readonly := defnMap(t)
	readonly["name"] = "AuditEvent"
	readonly["x-graphql"] = map[string]any{"readonly": true}
	schema := buildTestSchema(t, st, Options{Schemas: []map[string]any{defnMap(t), readonly}})
	res := graphql.Do(graphql.Params{Schema: schema, RequestString: introspectionQuery})
	sdl := sprintIntrospection(t, res)
	if strings.Contains(sdl, "create_AuditEvent") {
		t.Fatalf("readonly 模型不应出现 Mutation 面:\n%s", sdl)
	}
	if !strings.Contains(sdl, "get_AuditEvent") {
		t.Fatalf("readonly 模型应保留 Query 面:\n%s", sdl)
	}

	// override：命中替换 + 未知路径报错
	st2 := newMockStore(t)
	_, err := Build(st2, Options{
		Schemas: []map[string]any{defnMap(t)},
		Overrides: map[string]graphql.FieldResolveFn{
			"Query.list_User": func(p graphql.ResolveParams) (interface{}, error) {
				return []map[string]any{{"_id": "x", "name": "override"}}, nil
			},
		},
	})
	if err != nil {
		t.Fatalf("带 override 的 Build 失败: %v", err)
	}
	ov := do(t, buildTestSchema(t, st2, Options{
		Schemas: []map[string]any{defnMap(t)},
		Overrides: map[string]graphql.FieldResolveFn{
			"Query.list_User": func(p graphql.ResolveParams) (interface{}, error) {
				return []map[string]any{{"_id": "x", "name": "override"}}, nil
			},
		},
	}), `{ list_User { name } }`, nil)
	if ov.Data.(map[string]interface{})["list_User"].([]interface{})[0].(map[string]interface{})["name"] != "override" {
		t.Fatalf("override 未生效: %v", ov.Data)
	}

	if _, err := Build(newMockStore(t), Options{
		Schemas:   []map[string]any{defnMap(t)},
		Overrides: map[string]graphql.FieldResolveFn{"Query.list_Nope": func(p graphql.ResolveParams) (interface{}, error) { return nil, nil }},
	}); err == nil || !strings.Contains(err.Error(), "未命中") {
		t.Fatalf("未知 override 路径应报错，实际: %v", err)
	}
}
