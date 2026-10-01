// demo —— go 端真实接法示例（需 go-store 的 rust core FFI 产物在位，见 go-store/README）。
//
// 运行：go run ./demo   （默认监听 :4000，端点 /graphql）
package main

import (
	"log"
	"net/http"

	gostore "github.com/coenddt/go-store"
	"github.com/coenddt/store-graphql-go"
)

var userDefn = map[string]any{
	"name":      "User",
	"collection": "users",
	"idPrefix":  "u",
	"fields": map[string]any{
		"_id":  map[string]any{"type": "string"},
		"name": map[string]any{"type": "string"},
		"age":  map[string]any{"type": "int"},
	},
}

func main() {
	st, err := gostore.Open("sqlite::memory:")
	if err != nil {
		log.Fatalf("打开 store 失败: %v", err)
	}
	defer st.Close()
	if err := st.Register(userDefn); err != nil {
		log.Fatalf("注册 schema 失败: %v", err)
	}

	schema, err := storegraphql.Build(st, storegraphql.Options{
		Schemas: []map[string]any{userDefn}, // 与 Register 同一份 defn（spec/01）
		ContextProvider: func(r *http.Request) (*gostore.Context, error) {
			// spec/04：请求头 → store 上下文；返回 nil 同样注入（清除语义落地）
			return nil, nil
		},
	})
	if err != nil {
		log.Fatalf("构建 GraphQL schema 失败: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
	log.Println("GraphQL endpoint: http://localhost:4000/graphql")
	log.Fatal(http.ListenAndServe(":4000", mux))
}
