// Package storegraphql —— store-graphql 的 Go 适配器：为 go-store 已注册 schema 自动生成标准 GraphQL API。
//
// 语义依据：../spec/*.md（多端 parity，改动先改 spec）。
// 设计哲学：GraphQL 只是 GQL 的又一层 HTTP 皮 —— 适配层零语义发明。
//
// 用法：
//
//	st, _ := gostore.Open("app.db")
//	_ = st.Register(defn)
//	schema, _ := storegraphql.Build(st, storegraphql.Options{Schemas: []map[string]any{defn}})
//	http.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{ContextProvider: myProvider}))
//
// store 端口契约见 spec/00（接口签名对齐 gostore.Store 实际方法）。
package storegraphql

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/coenddt/go-store"
	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"
)

// maxBodyBytes 请求体上限（对齐 store-api/go/adapter.go 的 1MB 先例，防大 body 撑内存）。
const maxBodyBytes = 1 << 20

const archiveSuffix = "Deleted"

// Store 适配层依赖的 store 端口（spec/00；签名对齐 gostore.Store 公开方法）。
type Store interface {
	Query(ctx context.Context, gql string, params map[string]any, actx *gostore.Context) ([]map[string]any, error)
	Insert(ctx context.Context, schema string, data map[string]any, actx *gostore.Context) (map[string]any, error)
	Update(ctx context.Context, schema string, condition, data map[string]any, actx *gostore.Context) (map[string]any, error)
	Remove(ctx context.Context, schema string, condition map[string]any, actx *gostore.Context) (map[string]any, error)
}

// Options 适配器选项（语义对齐 store-graphql-node / store-graphql-py）。
type Options struct {
	// Resources 显式模型名；nil 时取 Schemas 全部（仍过滤归档表）。
	Resources []string
	// Schemas 注册用 defn 列表（spec/01：go-store 不回读 defn，与 gostore.Register 共用同一份）。
	Schemas []map[string]any
	// Overrides spec/03 钩子 2：按 "Query.get_X" / "Mutation.create_X" 路径替换生成 resolver。
	Overrides map[string]graphql.FieldResolveFn
	// Extensions spec/03 钩子 3：向 Query/Mutation 追加自定义字段（键仅限二者）。
	Extensions map[string]graphql.Fields
	// IDField 单条主键字段名（spec/02：默认 "_id"）。
	IDField string
	// ContextProvider spec/04：每请求上下文钩子。nil 时不注入。
	ContextProvider func(r *http.Request) (*gostore.Context, error)
}

// FilterArchived 归档表过滤（spec/01，多端逐字一致）。
func FilterArchived(names []string) []string {
	set := make(map[string]struct{}, len(names))
	for _, n := range names {
		set[n] = struct{}{}
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if strings.HasSuffix(n, archiveSuffix) {
			if _, ok := set[strings.TrimSuffix(n, archiveSuffix)]; ok {
				continue
			}
		}
		out = append(out, n)
	}
	return out
}

// jsonScalar spec/01：JSON 标量只接受 variables；graphql-go 的 ParseLiteral 无 error 通道，
// 返回 nil 由参数非空校验拦截内联 JSON（spec/02 go 端差异）。
var jsonScalar = graphql.NewScalar(graphql.ScalarConfig{
	Name:        "JSON",
	Description: "任意 JSON 值（条件/排序/写入文档）。只接受 variables 形式（spec/02）。",
	Serialize:   func(v interface{}) interface{} { return v },
	ParseValue:  func(v interface{}) interface{} { return v },
	ParseLiteral: func(_ ast.Value) interface{} {
		return nil
	},
})

// ── spec/01：defn 字段类型 → GraphQL 输出类型 ──

func scalarFor(typeName string) graphql.Type {
	switch typeName {
	case "string", "datetime":
		return graphql.String
	case "int":
		return graphql.Int
	case "float":
		return graphql.Float
	case "bool":
		return graphql.Boolean
	default:
		return jsonScalar
	}
}

func outType(fieldDefn map[string]any, typeName string) graphql.Type {
	t, _ := fieldDefn["type"].(string)
	if t == "object" {
		if sub, ok := fieldDefn["fields"].(map[string]any); ok {
			return graphql.NewObject(graphql.ObjectConfig{
				Name:        typeName,
				Description: descOf(fieldDefn), // spec/05：description 透传不改写
				Fields:      fieldsMap(sub, typeName),
			})
		}
	}
	return scalarFor(t)
}

// descOf spec/05：description 透传（缺失返回空串，graphql-go 视同无描述）。
func descOf(defn map[string]any) string {
	d, _ := defn["description"].(string)
	return d
}

func fieldsMap(fields map[string]any, typeName string) graphql.Fields {
	out := graphql.Fields{}
	for k, v := range fields {
		defn, _ := v.(map[string]any)
		if defn == nil {
			continue
		}
		t := graphql.Type(jsonScalar)
		if k == "_id" {
			t = graphql.NewNonNull(graphql.ID)
		} else {
			t = outType(defn, typeName+"_"+k)
		}
		out[k] = &graphql.Field{Type: t, Description: descOf(defn)}
	}
	return out
}

func modelFields(defn map[string]any) map[string]any {
	merged := map[string]any{}
	for k, v := range defn["fields"].(map[string]any) {
		merged[k] = v
	}
	if computes, ok := defn["computes"].(map[string]any); ok { // spec/01：computes 视同字段
		for k, v := range computes {
			merged[k] = v
		}
	}
	return merged
}

// ── spec/02：selection → GQL 投影串（fragments 展开 + @skip/@include 求值 + 空投影回退）──

func argIf(directives []*ast.Directive, variableValues map[string]any) (name string, val any, ok bool) {
	for _, d := range directives {
		if d.Name != nil && (d.Name.Value == "skip" || d.Name.Value == "include") {
			for _, a := range d.Arguments {
				if a.Name.Value != "if" {
					continue
				}
				switch v := a.Value.(type) {
				case *ast.Variable:
					if variableValues != nil {
						if got, present := variableValues[v.Name.Value]; present {
							return d.Name.Value, got, true
						}
					}
				case *ast.BooleanValue:
					return d.Name.Value, v.Value, true
				}
			}
		}
	}
	return "", nil, false
}

func shouldInclude(sel ast.Selection, variableValues map[string]any) bool {
	var directives []*ast.Directive
	switch s := sel.(type) {
	case *ast.Field:
		directives = s.Directives
	case *ast.InlineFragment:
		directives = s.Directives
	default:
		return true
	}
	name, val, ok := argIf(directives, variableValues)
	if !ok {
		return true
	}
	if name == "skip" {
		return !truthy(val)
	}
	return truthy(val) // include
}

func truthy(v any) bool {
	b, _ := v.(bool)
	return b
}

// projectionFrom 把 ResolveParams 的 selection 序列化为 GQL 投影串。
// 含 FragmentSpread 时经 info.Fragments 展开展开失败则回退 allFields（spec/02 go 端差异）。
func projectionFrom(p graphql.ResolveParams, allFields []string) string {
	var walk func(sel ast.Selection) string
	walk = func(sel ast.Selection) string {
		switch s := sel.(type) {
		case *ast.Field:
			if !shouldInclude(sel, p.Info.VariableValues) {
				return ""
			}
			head := s.Name.Value
			if s.SelectionSet != nil {
				parts := make([]string, 0, len(s.SelectionSet.Selections))
				for _, sub := range s.SelectionSet.Selections {
					if w := walk(sub); w != "" {
						parts = append(parts, w)
					}
				}
				if len(parts) > 0 {
					return head + " { " + strings.Join(parts, ", ") + " }"
				}
			}
			return head
		case *ast.InlineFragment:
			if s.SelectionSet == nil {
				return ""
			}
			parts := []string{}
			for _, sub := range s.SelectionSet.Selections {
				if w := walk(sub); w != "" {
					parts = append(parts, w)
				}
			}
			return strings.Join(parts, ", ")
		case *ast.FragmentSpread:
			if p.Info.Fragments != nil {
				if def, ok := p.Info.Fragments[s.Name.Value]; ok && def.GetSelectionSet() != nil {
					parts := []string{}
					for _, sub := range def.GetSelectionSet().Selections {
						if w := walk(sub); w != "" {
							parts = append(parts, w)
						}
					}
					return strings.Join(parts, ", ")
				}
			}
			return ""
		}
		return ""
	}

	root := p.Info.FieldASTs
	if len(root) == 0 || root[0].SelectionSet == nil {
		return fallbackProjection(allFields)
	}
	parts := []string{}
	for _, sel := range root[0].SelectionSet.Selections {
		if w := walk(sel); w != "" {
			parts = append(parts, w)
		}
	}
	if len(parts) == 0 {
		return fallbackProjection(allFields)
	}
	return strings.Join(parts, ", ")
}

func fallbackProjection(allFields []string) string {
	if len(allFields) == 0 {
		return "_id"
	}
	return strings.Join(allFields, ", ")
}

// ── spec/02：根 resolver（投影下推，无 N+1）──

type ctxKey struct{}

func withActx(ctx context.Context, actx *gostore.Context) context.Context {
	return context.WithValue(ctx, ctxKey{}, actx)
}

func actxFrom(ctx context.Context) *gostore.Context {
	if v, ok := ctx.Value(ctxKey{}).(*gostore.Context); ok {
		return v
	}
	return nil
}

func makeGet(st Store, name, idField string, allFields []string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		proj := projectionFrom(p, allFields)
		rows, err := st.Query(p.Context, fmt.Sprintf("%s($condition:@c0) { %s }", name, proj),
			map[string]any{"c0": map[string]any{idField: p.Args["id"]}}, actxFrom(p.Context))
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return rows[0], nil
		}
		return nil, nil
	}
}

// spec/02 limit 守卫常量：core 的行数封顶仅 text2query 档生效（standard 档原样返回），
// 适配层守上界；调整先改 spec 再三端同步。
const (
	listLimitDefault = 50
	listLimitMax     = 1000
)

func makeList(st Store, name string, allFields []string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		// spec/02 limit 守卫：缺省 50 防全表；超上限抛错（ERR_LIMIT: 稳定前缀），不静默截断
		limit := listLimitDefault
		if v, ok := p.Args["limit"]; ok && v != nil {
			limit = v.(int)
			if limit > listLimitMax {
				return nil, fmt.Errorf("ERR_LIMIT:list limit 上限 %d,收到 %d", listLimitMax, limit)
			}
		}
		proj := projectionFrom(p, allFields)
		parts, params := []string{}, map[string]any{}
		if v, ok := p.Args["condition"]; ok && v != nil {
			parts = append(parts, "$condition:@c0")
			params["c0"] = v
		}
		if v, ok := p.Args["sort"]; ok && v != nil {
			parts = append(parts, "$sort:@s1")
			params["s1"] = v
		}
		parts = append(parts, "$limit:@l")
		params["l"] = limit
		head := name + "(" + strings.Join(parts, ",") + ")"
		return st.Query(p.Context, fmt.Sprintf("%s { %s }", head, proj), params, actxFrom(p.Context))
	}
}

func makeCreate(st Store, name string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		input, _ := p.Args["input"].(map[string]any)
		return st.Insert(p.Context, name, input, actxFrom(p.Context))
	}
}

func makeUpdate(st Store, name, idField string, allFields []string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		set, _ := p.Args["set"].(map[string]any)
		if _, err := st.Update(p.Context, name, map[string]any{idField: p.Args["id"]}, set, actxFrom(p.Context)); err != nil {
			return nil, err
		}
		proj := projectionFrom(p, allFields)
		rows, err := st.Query(p.Context, fmt.Sprintf("%s($condition:@c0) { %s }", name, proj),
			map[string]any{"c0": map[string]any{idField: p.Args["id"]}}, actxFrom(p.Context))
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return rows[0], nil
		}
		return nil, nil
	}
}

func makeDelete(st Store, name, idField string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		if _, err := st.Remove(p.Context, name, map[string]any{idField: p.Args["id"]}, actxFrom(p.Context)); err != nil {
			return nil, err
		}
		return true, nil
	}
}

// ── schema 构建 ──

// Build 程序化构建标准 GraphQL schema（spec/01 生成面）。
func Build(st Store, opts Options) (graphql.Schema, error) {
	var schema graphql.Schema
	if opts.IDField == "" {
		opts.IDField = "_id"
	}
	overrides := opts.Overrides
	extensions := opts.Extensions
	usedOverride := map[string]bool{}

	resolveWithOverride := func(key string, fallback graphql.FieldResolveFn) graphql.FieldResolveFn {
		if fn, ok := overrides[key]; ok {
			usedOverride[key] = true
			return fn
		}
		return fallback
	}

	// 模型 defn 依据（spec/01）：go-store 不回读 defn，按 Schemas 传入的 defn 键序生成
	names := opts.Resources
	if names == nil {
		names = make([]string, 0, len(opts.Schemas))
		for _, defn := range opts.Schemas {
			if n, _ := defn["name"].(string); n != "" {
				names = append(names, n)
			}
		}
	}
	byName := map[string]map[string]any{}
	for _, defn := range opts.Schemas {
		if n, _ := defn["name"].(string); n != "" {
			byName[n] = defn
		}
	}
	names = FilterArchived(names)

	queryFields := graphql.Fields{}
	mutationFields := graphql.Fields{}
	for _, name := range names {
		defn := byName[name]
		if defn == nil {
			return schema, fmt.Errorf("模型 %q 未在 Options.Schemas 中提供 defn（spec/01）", name)
		}
		xg, _ := defn["x-graphql"].(map[string]any)
		if xg != nil {
			if hidden, _ := xg["hidden"].(bool); hidden { // spec/03 钩子 1
				continue
			}
		}
		allFields := defnFieldKeys(defn)
		modelType := graphql.NewObject(graphql.ObjectConfig{
			Name:        name,
			Description: descOf(defn), // spec/05
			Fields:      fieldsMap(modelFields(defn), name),
		})

		queryFields["get_"+name] = &graphql.Field{
			Type: modelType,
			Args: graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)}},
			Resolve: resolveWithOverride("Query.get_"+name, makeGet(st, name, opts.IDField, allFields)),
		}
		queryFields["list_"+name] = &graphql.Field{
			Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(modelType))),
			Args: graphql.FieldConfigArgument{
				"condition": &graphql.ArgumentConfig{Type: jsonScalar},
				"sort":      &graphql.ArgumentConfig{Type: jsonScalar},
				"limit":     &graphql.ArgumentConfig{Type: graphql.Int},
			},
			Resolve: resolveWithOverride("Query.list_"+name, makeList(st, name, allFields)),
		}
		readonly := false
		if xg != nil {
			readonly, _ = xg["readonly"].(bool)
		}
		if !readonly { // spec/03 钩子 1：readonly → 只出 Query
			mutationFields["create_"+name] = &graphql.Field{
				Type: modelType,
				Args: graphql.FieldConfigArgument{"input": &graphql.ArgumentConfig{Type: graphql.NewNonNull(jsonScalar)}},
				Resolve: resolveWithOverride("Mutation.create_"+name, makeCreate(st, name)),
			}
			mutationFields["update_"+name] = &graphql.Field{
				Type: modelType,
				Args: graphql.FieldConfigArgument{
					"id":  &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)},
					"set": &graphql.ArgumentConfig{Type: graphql.NewNonNull(jsonScalar)},
				},
				Resolve: resolveWithOverride("Mutation.update_"+name, makeUpdate(st, name, opts.IDField, allFields)),
			}
			mutationFields["delete_"+name] = &graphql.Field{
				Type: graphql.NewNonNull(graphql.Boolean),
				Args: graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)}},
				Resolve: resolveWithOverride("Mutation.delete_"+name, makeDelete(st, name, opts.IDField)),
			}
		}
	}

	for key, fields := range extensions { // spec/03 钩子 3
		switch key {
		case "Query":
			for f, v := range fields {
				queryFields[f] = v
			}
		case "Mutation":
			for f, v := range fields {
				mutationFields[f] = v
			}
		default:
			return schema, fmt.Errorf("Extensions 仅支持 Query/Mutation，收到 %q（spec/03）", key)
		}
	}

	for key := range overrides { // spec/03：未知路径构建报错不静默
		if !usedOverride[key] {
			return schema, fmt.Errorf("override 路径 %q 未命中任何生成字段（spec/03）", key)
		}
	}

	if len(queryFields) == 0 {
		return schema, fmt.Errorf("无可用模型（Schemas 为空或全部 hidden）")
	}
	cfg := graphql.SchemaConfig{
		Query: graphql.NewObject(graphql.ObjectConfig{Name: "Query", Fields: queryFields}),
	}
	if len(mutationFields) > 0 {
		cfg.Mutation = graphql.NewObject(graphql.ObjectConfig{Name: "Mutation", Fields: mutationFields})
	}
	return graphql.NewSchema(cfg)
}

func defnFieldKeys(defn map[string]any) []string {
	out := []string{}
	if fields, ok := defn["fields"].(map[string]any); ok {
		for k := range fields {
			out = append(out, k)
		}
	}
	if computes, ok := defn["computes"].(map[string]any); ok {
		for k := range computes {
			out = append(out, k)
		}
	}
	return out
}

// graphiqlHTML spec/05：GraphiQL 文档页（CDN 版，GET /graphql 返回；POST 才执行查询）。
const graphiqlHTML = `<!doctype html>
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
`

// Handler GraphQL over HTTP（spec/04）：POST application/json；GET 返回 GraphiQL 文档页（spec/05）。
func Handler(schema graphql.Schema, opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(graphiqlHTML))
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, `{"errors":[{"message":"仅支持 POST（spec/04）"}]}`, http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Query         string                 `json:"query"`
			Variables     map[string]interface{} `json:"variables"`
			OperationName string                 `json:"operationName"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes)).Decode(&body); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"errors":[{"message":"请求体必须是 JSON"}]}`))
			return
		}
		ctx := r.Context()
		if opts.ContextProvider != nil {
			actx, err := opts.ContextProvider(r)
			if err != nil {
				// spec/04：PermissionError ⇒ 403（RBAC 拒绝）；其余 ⇒ 401。
				// 判定按 core 稳定前缀 ERR_PERMISSION:（ERR_PERM_PREFIX 契约，禁按文案匹配）。
				status := http.StatusUnauthorized
				if isPermissionError(err) {
					status = http.StatusForbidden
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = fmt.Fprintf(w, `{"errors":[{"message":%q}]}`, err.Error())
				return
			}
			ctx = withActx(ctx, actx)
		}
		result := graphql.Do(graphql.Params{
			Schema:         schema,
			Context:        ctx,
			RequestString:  body.Query,
			VariableValues: body.Variables,
			OperationName:  body.OperationName,
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}

// isPermissionError 按稳定前缀判定（core ERR_PERM_PREFIX 契约，同 store-api/go/errors.go）。
func isPermissionError(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), "ERR_PERMISSION:")
}
