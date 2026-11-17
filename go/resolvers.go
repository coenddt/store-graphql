// resolvers.go —— spec/02 投影下推与根 resolver：selection → GQL 投影串、get/list/create/update/delete。
// 本文件依赖 adapter.go 的 Store 端口与 schema.go 的 jsonScalar（同包引用）。

package storegraphql

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"

	gostore "github.com/coenddt/go-store"
)

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
	// joinSet 遍历子选择集并 join（Field/InlineFragment/FragmentSpread 三分支共用形态）。
	joinSet := func(set *ast.SelectionSet) string {
		parts := []string{}
		for _, sub := range set.Selections {
			if w := walk(sub); w != "" {
				parts = append(parts, w)
			}
		}
		return strings.Join(parts, ", ")
	}
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
			return joinSet(s.SelectionSet)
		case *ast.FragmentSpread:
			if p.Info.Fragments != nil {
				if def, ok := p.Info.Fragments[s.Name.Value]; ok && def.GetSelectionSet() != nil {
					return joinSet(def.GetSelectionSet())
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

// findByKey 深度优先找第一个同名键（`$near` 只允许出现一次，由 core 保证）。
func findByKey(node any, key string) any {
	switch v := node.(type) {
	case map[string]any:
		if hit, ok := v[key]; ok {
			return hit
		}
		for _, sub := range v {
			if hit := findByKey(sub, key); hit != nil {
				return hit
			}
		}
	case []any:
		for _, sub := range v {
			if hit := findByKey(sub, key); hit != nil {
				return hit
			}
		}
	}
	return nil
}

// asInt 数值安全转 int：int64 / float64 超出平台 int 可表范围时拒绝（防大数转 int
// 产出垃圾值再被 limit 逻辑误用）；范围内的 float64 小数截断与既有 $near.$limit
// 行为一致（不做新语义）。
func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		if n < math.MinInt || n > math.MaxInt {
			return 0, false
		}
		return int(n), true
	case float64:
		if n < math.MinInt || n > math.MaxInt {
			return 0, false
		}
		return int(n), true
	}
	return 0, false
}

// vectorLimitGuard 含 `$near` → true（不拼根 `$limit`）；显式 limit 并用 → ERR_LIMIT。
func vectorLimitGuard(condition any, explicit *int) (bool, error) {
	near := findByKey(condition, "$near")
	if near == nil {
		return false, nil
	}
	if explicit != nil {
		return true, fmt.Errorf("ERR_LIMIT:list limit 与 $near.$limit 互斥，请只传 $near.$limit")
	}
	if m, ok := near.(map[string]any); ok {
		if n, ok := asInt(m["$limit"]); ok && n > listLimitMax {
			return true, fmt.Errorf("ERR_LIMIT:$near.$limit 上限 %d,收到 %d", listLimitMax, n)
		}
	}
	return true, nil
}

func makeList(st Store, name string, allFields []string) graphql.FieldResolveFn {
	return func(p graphql.ResolveParams) (interface{}, error) {
		var explicit *int
		if v, ok := p.Args["limit"]; ok && v != nil {
			// graphql-go 解出的 limit 可能是 int 或 variables 路径的 float64/int64：
			// 统一经 asInt（带范围检查）；不可转即显式报错，不 panic（崩溃是缺陷非语义）。
			n, ok := asInt(v)
			if !ok {
				return nil, fmt.Errorf("ERR_LIMIT:list limit 必须是整数,收到 %T", v)
			}
			explicit = &n
		}
		hasNear, err := vectorLimitGuard(p.Args["condition"], explicit)
		if err != nil {
			return nil, err
		}
		// spec/02 limit 守卫：缺省 50 防全表；超上限抛错（ERR_LIMIT: 稳定前缀），不静默截断
		limit := listLimitDefault
		if explicit != nil {
			limit = *explicit
		}
		if !hasNear && limit > listLimitMax {
			return nil, fmt.Errorf("ERR_LIMIT:list limit 上限 %d,收到 %d", listLimitMax, limit)
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
		if !hasNear { // 向量查询的条数唯一来源是 $near.$limit
			parts = append(parts, "$limit:@l")
			params["l"] = limit
		}
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
