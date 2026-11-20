// schema.go —— spec/01 类型生成面：defn 字段类型 → GraphQL 输出类型，schema 构建（Build 族）。

package storegraphql

import (
	"fmt"

	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"
)

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
		var t graphql.Type
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
	// fields 缺失或类型不符时容错跳过（只含 computes + _score），与 fieldsMap 的
	// 容错形态一致——单值断言会对脏 defn panic（崩溃是缺陷非设计语义）。
	if fields, ok := defn["fields"].(map[string]any); ok {
		for k, v := range fields {
			merged[k] = v
		}
	}
	if computes, ok := defn["computes"].(map[string]any); ok { // spec/01：computes 视同字段
		for k, v := range computes {
			merged[k] = v
		}
	}
	// `_score`：向量检索派生列（04），恒注入且可空
	merged["_score"] = map[string]any{
		"type":        "float",
		"description": "向量检索相似度得分（越大越相似）",
	}
	return merged
}

// ── schema 构建 ──

// schemaIndex 模型名清单 + defn 索引（spec/01：go-store 不回读 defn，按 Schemas 键序生成；
// 默认归档过滤，IncludeArchived=true 为显式开关；`__` 保留名过滤始终生效）。
func schemaIndex(opts Options) ([]string, map[string]map[string]any) {
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
	if !opts.IncludeArchived {
		names = FilterArchived(names)
	}
	names = filterReserved(names)
	return names, byName
}

// buildModelEntry 生成单模型的 Query(get/list) 与 Mutation(create/update/delete) 字段
// （spec/03 钩子 1：x-graphql.hidden 整模型隐藏；readonly → 只出 Query）。
func buildModelEntry(
	st Store, opts Options,
	resolveWithOverride func(string, graphql.FieldResolveFn) graphql.FieldResolveFn,
	name string, defn map[string]any,
	queryFields, mutationFields graphql.Fields,
) {
	xg, _ := defn["x-graphql"].(map[string]any)
	if xg != nil {
		if hidden, _ := xg["hidden"].(bool); hidden {
			return
		}
	}
	allFields := defnFieldKeys(defn)
	modelType := graphql.NewObject(graphql.ObjectConfig{
		Name:        name,
		Description: descOf(defn), // spec/05
		Fields:      fieldsMap(modelFields(defn), name),
	})

	queryFields["get"+name] = &graphql.Field{
		Type:    modelType,
		Args:    graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)}},
		Resolve: resolveWithOverride("Query.get"+name, makeGet(st, name, opts.IDField, allFields)),
	}
	queryFields["list"+name] = &graphql.Field{
		Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(modelType))),
		Args: graphql.FieldConfigArgument{
			"condition": &graphql.ArgumentConfig{Type: jsonScalar},
			"sort":      &graphql.ArgumentConfig{Type: jsonScalar},
			"limit":     &graphql.ArgumentConfig{Type: graphql.Int},
		},
		Resolve: resolveWithOverride("Query.list"+name, makeList(st, name, allFields)),
	}
	// spec/01 pageX：列表 + total + hasMore（宿主 QueryWithCount 的薄暴露）
	pageType := graphql.NewObject(graphql.ObjectConfig{
		Name:        name + "Page",
		Description: name + " 分页结果（items + total + hasMore + page + pageSize）",
		Fields: graphql.Fields{
			"items":    &graphql.Field{Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(modelType)))},
			"total":    &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
			"hasMore":  &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
			"page":     &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
			"pageSize": &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		},
	})
	queryFields["page"+name] = &graphql.Field{
		Type: graphql.NewNonNull(pageType),
		Args: graphql.FieldConfigArgument{
			"condition": &graphql.ArgumentConfig{Type: jsonScalar},
			"sort":      &graphql.ArgumentConfig{Type: jsonScalar},
			"page":      &graphql.ArgumentConfig{Type: graphql.Int},
			"pageSize":  &graphql.ArgumentConfig{Type: graphql.Int},
		},
		Resolve: resolveWithOverride("Query.page"+name, makePage(st, name, allFields)),
	}
	readonly := false
	if xg != nil {
		readonly, _ = xg["readonly"].(bool)
	}
	if !readonly { // spec/03 钩子 1：readonly → 只出 Query
		mutationFields["create"+name] = &graphql.Field{
			Type:    modelType,
			Args:    graphql.FieldConfigArgument{"input": &graphql.ArgumentConfig{Type: graphql.NewNonNull(jsonScalar)}},
			Resolve: resolveWithOverride("Mutation.create"+name, makeCreate(st, name)),
		}
		mutationFields["update"+name] = &graphql.Field{
			Type: modelType,
			Args: graphql.FieldConfigArgument{
				"id":  &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)},
				"set": &graphql.ArgumentConfig{Type: graphql.NewNonNull(jsonScalar)},
			},
			Resolve: resolveWithOverride("Mutation.update"+name, makeUpdate(st, name, opts.IDField, allFields)),
		}
		mutationFields["delete"+name] = &graphql.Field{
			Type:    graphql.NewNonNull(graphql.Boolean),
			Args:    graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)}},
			Resolve: resolveWithOverride("Mutation.delete"+name, makeDelete(st, name, opts.IDField)),
		}
	}
}

// applyExtensions spec/03 钩子 3：extensions 合并（仅支持 Query/Mutation，未知键构建报错）。
func applyExtensions(queryFields, mutationFields graphql.Fields, extensions map[string]graphql.Fields) error {
	for key, fields := range extensions {
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
			return fmt.Errorf("extensions 仅支持 Query/Mutation，收到 %q（spec/03）", key)
		}
	}
	return nil
}

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

	names, byName := schemaIndex(opts)

	queryFields := graphql.Fields{}
	mutationFields := graphql.Fields{}
	for _, name := range names {
		defn := byName[name]
		if defn == nil {
			return schema, fmt.Errorf("模型 %q 未在 Options.Schemas 中提供 defn（spec/01）", name)
		}
		buildModelEntry(st, opts, resolveWithOverride, name, defn, queryFields, mutationFields)
	}

	if err := applyExtensions(queryFields, mutationFields, extensions); err != nil {
		return schema, err
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
	out = append(out, "_score") // 04：回退投影必须包含派生列
	return out
}
