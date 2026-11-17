// demo —— go 端真实接法示例（需 go-store 的 rust core FFI 产物在位，见 go-store/README）。
//
// 运行：go run ./demo   （默认监听 :4000，端点 /graphql）
package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	gostore "github.com/coenddt/go-store"

	storegraphql "github.com/coenddt/store-graphql-go"
)

var userDefn = map[string]any{
	"name":       "User",
	"collection": "users",
	"idPrefix":   "u",
	"fields": map[string]any{
		"_id":  map[string]any{"type": "string"},
		"name": map[string]any{"type": "string"},
		"age":  map[string]any{"type": "int"},
	},
}

func main() {
	// 错误单点出口：defer 在 run 返回时正常执行，资源释放不受退出路径影响。
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	st, err := gostore.Open("sqlite::memory:")
	if err != nil {
		return fmt.Errorf("打开 store 失败: %w", err)
	}
	defer func() { _ = st.Close() }()
	if err := st.Register(userDefn); err != nil {
		return fmt.Errorf("注册 schema 失败: %w", err)
	}

	schema, err := storegraphql.Build(st, storegraphql.Options{
		Schemas: []map[string]any{userDefn}, // 与 Register 同一份 defn（spec/01）
		ContextProvider: func(_ *http.Request) (*gostore.Context, error) {
			// spec/04：请求头 → store 上下文；返回 nil 同样注入（清除语义落地）
			return nil, nil
		},
	})
	if err != nil {
		return fmt.Errorf("构建 GraphQL schema 失败: %w", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/graphql", storegraphql.Handler(schema, storegraphql.Options{}))
	srv := &http.Server{
		Addr:              ":4000",
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second, // G114：慢速连接防悬挂（无超时 server 是安全缺陷）
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Println("GraphQL endpoint: http://localhost:4000/graphql")
	return srv.ListenAndServe()
}
