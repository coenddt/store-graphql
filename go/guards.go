// guards.go —— spec/04 查询守卫：深度 / 复杂度 / introspection 的 AST 级静态检查。
//
// 语义依据：../spec/04（多端 parity，改动先改 spec）。
// 三端同构算法：FragmentSpread 按定义递归展开，visiting 集合防环。

package storegraphql

import "github.com/graphql-go/graphql/language/ast"

// maxQueryDepth spec/04 查询深度守卫：深度 = 从 operation 顶层 selectionSet 起的最大字段
// 嵌套层数；超限 HTTP 400 + ERR_DEPTH: 稳定前缀。调整先改 spec 再三端同步。
const maxQueryDepth = 10

// maxQueryFields spec/04 复杂度守卫：AST 字段节点总数（别名不单列——字段计数已覆盖别名堆叠）。
const maxQueryFields = 300

// queryFieldCount 字段计数 + introspection 使用检测（fragment 展开计入，防环；__typename 放行）。
func queryFieldCount(doc *ast.Document) (fields int, introspectionUsed bool) {
	fragments := map[string]*ast.FragmentDefinition{}
	for _, def := range doc.Definitions {
		if fd, ok := def.(*ast.FragmentDefinition); ok && fd.Name != nil {
			fragments[fd.Name.Value] = fd
		}
	}
	var walkSelSet func(selSet *ast.SelectionSet, visiting map[string]bool)
	walkSelSet = func(selSet *ast.SelectionSet, visiting map[string]bool) {
		if selSet == nil {
			return
		}
		for _, sel := range selSet.Selections {
			switch s := sel.(type) {
			case *ast.Field:
				fields++
				if !introspectionUsed && s.Name != nil && (s.Name.Value == "__schema" || s.Name.Value == "__type") {
					introspectionUsed = true
				}
				walkSelSet(s.SelectionSet, visiting)
			case *ast.InlineFragment:
				walkSelSet(s.SelectionSet, visiting)
			case *ast.FragmentSpread:
				name := s.Name.Value
				if !visiting[name] {
					if frag, ok := fragments[name]; ok {
						next := make(map[string]bool, len(visiting)+1)
						for k := range visiting {
							next[k] = true
						}
						next[name] = true
						walkSelSet(frag.SelectionSet, next)
					}
				}
			}
		}
	}
	for _, def := range doc.Definitions {
		if op, ok := def.(*ast.OperationDefinition); ok {
			walkSelSet(op.SelectionSet, map[string]bool{})
		}
	}
	return fields, introspectionUsed
}

// queryDepth 深度计算（三端同构算法）：FragmentSpread 按定义递归（visiting 防环）。
func queryDepth(doc *ast.Document) int {
	fragments := map[string]*ast.FragmentDefinition{}
	for _, def := range doc.Definitions {
		if fd, ok := def.(*ast.FragmentDefinition); ok && fd.Name != nil {
			fragments[fd.Name.Value] = fd
		}
	}
	var depthOfSelSet func(selSet *ast.SelectionSet, visiting map[string]bool) int
	depthOfSelSet = func(selSet *ast.SelectionSet, visiting map[string]bool) int {
		if selSet == nil {
			return 0
		}
		maxDepth := 0
		for _, sel := range selSet.Selections {
			d := 0
			switch s := sel.(type) {
			case *ast.Field:
				d = 1 + depthOfSelSet(s.SelectionSet, visiting)
			case *ast.InlineFragment:
				d = depthOfSelSet(s.SelectionSet, visiting)
			case *ast.FragmentSpread:
				name := s.Name.Value
				if !visiting[name] {
					if frag, ok := fragments[name]; ok {
						next := make(map[string]bool, len(visiting)+1)
						for k := range visiting {
							next[k] = true
						}
						next[name] = true
						d = depthOfSelSet(frag.SelectionSet, next)
					}
				}
			}
			if d > maxDepth {
				maxDepth = d
			}
		}
		return maxDepth
	}
	maxDepth := 0
	for _, def := range doc.Definitions {
		if op, ok := def.(*ast.OperationDefinition); ok {
			if d := depthOfSelSet(op.SelectionSet, map[string]bool{}); d > maxDepth {
				maxDepth = d
			}
		}
	}
	return maxDepth
}
