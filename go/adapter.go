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
// 本文件承载 HTTP 层（Options / Handler / 错误码）；schema 生成见 schema.go，
// resolver 与投影见 resolvers.go，查询守卫见 guards.go。
package storegraphql

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/gqlerrors"
	"github.com/graphql-go/graphql/language/parser"

	gostore "github.com/coenddt/go-store"
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
	// Overrides spec/03 钩子 2：按 "Query.getX" / "Mutation.createX" 路径替换生成 resolver。
	Overrides map[string]graphql.FieldResolveFn
	// Extensions spec/03 钩子 3：向 Query/Mutation 追加自定义字段（键仅限二者）。
	Extensions map[string]graphql.Fields
	// IDField 单条主键字段名（spec/02：默认 "_id"）。
	IDField string
	// MaxQueryDepth spec/04 查询深度上限；0 取默认 10。
	MaxQueryDepth int
	// MaxQueryFields spec/04 复杂度上限（AST 字段节点总数）；0 取默认 300。
	MaxQueryFields int
	// DisableIntrospection spec/04：true 时含 __schema/__type 的请求 ⇒ 400 + ERR_INTROSPECTION:。
	DisableIntrospection bool
	// DisableGraphiQL true 时 GET /graphql 返回 405（spec/04 仅 POST 执行）。
	// 零值 false = 保留 GraphiQL 文档页（spec/05 现行为）；与 DisableIntrospection
	// 同款倒置命名，零值即既有行为，不改变默认语义。
	DisableGraphiQL bool
	// IncludeArchived spec/01：true 时跳过归档表过滤（默认 false = 过滤）。
	// `__` 保留名过滤不受该开关影响。
	IncludeArchived bool
	// ContextProvider spec/04：每请求上下文钩子。nil 时不注入。
	ContextProvider func(r *http.Request) (*gostore.Context, error)
}

// gqlReservedPrefix GraphQL 规范：`__` 前缀保留给 introspection，不得作为类型名
// （spec/01 保留名过滤）。core 注册的控制面内建模型（__workflowRun / __schemaDef /
// __workflowDef / __feedback）一律不进公开类型空间。
const gqlReservedPrefix = "__"

// filterReserved GraphQL 保留名过滤（spec/01）：跳过 `__` 前缀模型，不报错——
// 与 node/py 端 filterReserved / filter_reserved 同语义（含显式 Resources 入参）。
// 该过滤为 GraphQL 皮专有约束（REST/gRPC/MCP 无此限制），故不并入 FilterArchived。
func filterReserved(names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		if strings.HasPrefix(n, gqlReservedPrefix) {
			continue
		}
		out = append(out, n)
	}
	return out
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

// Handler GraphQL over HTTP（spec/04）：POST application/json；GET 默认返回 GraphiQL
// serveGraphiQL GET 文档页（spec/05）；DisableGraphiQL=true 时按 spec/04 仅 POST
// 语义与其它方法一致返回 405。
func serveGraphiQL(w http.ResponseWriter, opts Options) {
	if opts.DisableGraphiQL {
		http.Error(w, `{"errors":[{"message":"仅支持 POST（spec/04）"}]}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(graphiqlHTML))
}

// guardPreExec spec/04 深度/复杂度/introspection 守卫：执行前独立 parse 检查
// （语法错不在此拦，交给 graphql.Do 原路径）。返回 true 表示已拦截并写好响应。
func guardPreExec(w http.ResponseWriter, query string, opts Options) bool {
	if query == "" {
		return false
	}
	depthLimit := opts.MaxQueryDepth
	if depthLimit <= 0 {
		depthLimit = maxQueryDepth
	}
	fieldsLimit := opts.MaxQueryFields
	if fieldsLimit <= 0 {
		fieldsLimit = maxQueryFields
	}
	doc, err := parser.Parse(parser.ParseParams{Source: query})
	if err != nil {
		return false
	}
	if d := queryDepth(doc); d > depthLimit {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, `{"errors":[{"message":"ERR_DEPTH:查询深度 %d 超过上限 %d","extensions":{"code":"ERR_DEPTH","normalizedCode":"DEPTH"}}]}`, d, depthLimit)
		return true
	}
	fields, introUsed := queryFieldCount(doc)
	if introUsed && opts.DisableIntrospection {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"errors":[{"message":"ERR_INTROSPECTION:introspection 已禁用","extensions":{"code":"ERR_INTROSPECTION","normalizedCode":"INTROSPECTION"}}]}`))
		return true
	}
	if fields > fieldsLimit {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, `{"errors":[{"message":"ERR_COMPLEXITY:查询字段数 %d 超过上限 %d","extensions":{"code":"ERR_COMPLEXITY","normalizedCode":"COMPLEXITY"}}]}`, fields, fieldsLimit)
		return true
	}
	return false
}

// Handler 返回 HTTP handler：GET 走文档页（spec/05，DisableGraphiQL=true 时按
// spec/04 仅 POST 语义返回 405）；POST 执行 GraphQL（spec/04 守卫 + 执行期错误补
// extensions.code，HTTP 200 契约）。
func Handler(schema graphql.Schema, opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			serveGraphiQL(w, opts)
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
				// spec/04：权限类（PermissionError / 同档 NoContext）⇒ 403（RBAC 拒绝）；其余 ⇒ 401。
				// 判定按 core 稳定前缀（ERR_PERMISSION: / ERR_NO_CONTEXT: 契约，禁按文案匹配）。
				status := http.StatusUnauthorized
				if isPermissionError(err) || isNoContextError(err) {
					status = http.StatusForbidden
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = fmt.Fprintf(w, `{"errors":[{"message":%q}]}`, err.Error())
				return
			}
			ctx = withActx(ctx, actx)
		}
		if guardPreExec(w, body.Query, opts) {
			return
		}
		result := graphql.Do(graphql.Params{
			Schema:         schema,
			Context:        ctx,
			RequestString:  body.Query,
			VariableValues: body.Variables,
			OperationName:  body.OperationName,
		})
		// spec/04：执行期错误统一补 extensions.code（去 ERR_ 前缀），权限类（含同档 NoContext）
		// 固定 FORBIDDEN；执行期错误保持 HTTP 200（GraphQL over HTTP 口径），不按状态码分叉。
		for i := range result.Errors {
			msg := result.Errors[i].Message
			if strings.HasPrefix(msg, "ERR_PERMISSION:") || strings.HasPrefix(msg, "ERR_NO_CONTEXT:") {
				setErrorCode(&result.Errors[i], "FORBIDDEN")
				continue
			}
			if code := stableErrorCode(msg); code != "" {
				setErrorCode(&result.Errors[i], code)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}

// isPermissionError 按稳定前缀判定（core ERR_PERM_PREFIX 契约，同 store-api/go/errors.go）。
func isPermissionError(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), "ERR_PERMISSION:")
}

// isNoContextError 判定权限类同档的 NoContext（requireContext 开启且 ctx 缺失，
// core 稳定前缀 ERR_NO_CONTEXT:）⇒ 403。
func isNoContextError(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), "ERR_NO_CONTEXT:")
}

// setErrorCode 补 extensions.code（保留已有 extensions 其它键；已有 code 不覆盖）。
func setErrorCode(e *gqlerrors.FormattedError, code string) {
	ex := e.Extensions
	if ex == nil {
		ex = map[string]interface{}{}
	}
	if _, ok := ex["code"]; !ok {
		ex["code"] = code
	}
	e.Extensions = ex
}

// stableErrorCode spec/04：非权限错误的稳定 machine code = message 的 `ERR_<CODE>:` 前缀去 `ERR_`；
// 无前缀 / 前缀非全大写 / `ERR_PERMISSION` 一律返回空串（权限类走 FORBIDDEN 分支，不在此改写）。
func stableErrorCode(message string) string {
	if !strings.HasPrefix(message, "ERR_") {
		return ""
	}
	head, _, ok := strings.Cut(message, ":")
	if !ok {
		return ""
	}
	code := strings.TrimPrefix(head, "ERR_")
	if code == "" || code == "PERMISSION" || code != strings.ToUpper(code) {
		return ""
	}
	return code
}
