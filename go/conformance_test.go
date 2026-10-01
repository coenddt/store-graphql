package storegraphql

// conformance runner — 直接消费 ../../conformance/cases/*.json 执行断言。
// 三端 runner 同构:同一份用例,同一套 expect 契约(dataKeys/gql/paramsLimit/errorCodePrefix)。
// 语义变更必须先改 spec/,再改 cases/,再三端 runner——三者不一致即为缺陷。

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/graphql-go/graphql"
)

type conformanceCase struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
	Steps  []struct {
		Query     string                 `json:"query"`
		Variables map[string]interface{} `json:"variables"`
		Expect    struct {
			DataKeys        []string `json:"dataKeys"`
			Gql             string   `json:"gql"`
			ParamsLimit     *int     `json:"paramsLimit"`
			ErrorCodePrefix string   `json:"errorCodePrefix"`
		} `json:"expect"`
	} `json:"steps"`
}

func TestConformance(t *testing.T) {
	raw, err := os.ReadFile("../../conformance/cases/users-graphql.json")
	if err != nil {
		t.Skipf("cases 文件不可达(单包发布场景): %v", err)
	}
	var c conformanceCase
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("用例解析失败: %v", err)
	}

	st := newMockStore(t)
	schema := buildTestSchema(t, st, Options{Schemas: []map[string]any{c.Schema}})

	for i, step := range c.Steps {
		res := graphql.Do(graphql.Params{
			Schema:         schema,
			Context:        context.Background(),
			RequestString:  step.Query,
			VariableValues: step.Variables,
		})
		expect := step.Expect
		if expect.ErrorCodePrefix != "" {
			if !res.HasErrors() || !strings.HasPrefix(res.Errors[0].Error(), expect.ErrorCodePrefix) {
				t.Fatalf("step#%d 应抛 %s,实际: %v", i, expect.ErrorCodePrefix, res.Errors)
			}
			continue
		}
		if res.HasErrors() {
			t.Fatalf("step#%d 不应有错误: %v", i, res.Errors)
		}
		data, _ := res.Data.(map[string]interface{})
		for _, key := range expect.DataKeys {
			if _, ok := data[key]; !ok {
				t.Fatalf("step#%d data 缺少 %q", i, key)
			}
		}
		if expect.Gql != "" {
			if got := st.gqlLog[len(st.gqlLog)-1]; got != expect.Gql {
				t.Fatalf("step#%d 投影下推串不符:\n got: %s\nwant: %s", i, got, expect.Gql)
			}
		}
		if expect.ParamsLimit != nil {
			params := st.lastParams
			if params == nil || params["l"] != *expect.ParamsLimit {
				t.Fatalf("step#%d params.l 不符: %v", i, params)
			}
		}
	}
}
