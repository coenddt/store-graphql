// units_test.go —— 包内纯函数单元测试（truthy / fallbackProjection / asInt，
// 不依赖 FFI；作为 mock 冒烟测试之外的最小单元锚点）。
package storegraphql

import "testing"

// TestTruthy truthy 只认布尔真：字符串 "true"、非零数字等一律为假
// （@skip/@include 的变量值按 GQL 规范必须是 Boolean）。
func TestTruthy(t *testing.T) {
	for _, c := range []struct {
		in   any
		want bool
	}{
		{true, true},
		{false, false},
		{"true", false},
		{1, false},
		{float64(1), false},
		{nil, false},
	} {
		if got := truthy(c.in); got != c.want {
			t.Fatalf("truthy(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestFallbackProjection 展开失败回退：空字段集回退 _id，否则全字段投影串。
func TestFallbackProjection(t *testing.T) {
	if got := fallbackProjection(nil); got != "_id" {
		t.Fatalf("空字段集应回退 _id: %q", got)
	}
	if got := fallbackProjection([]string{"name", "age"}); got != "name, age" {
		t.Fatalf("全字段投影 = %q", got)
	}
}

// TestAsInt 数值形态归一：int/int64/float64 接受（float 截断），其余显式拒绝。
func TestAsInt(t *testing.T) {
	for _, c := range []struct {
		in   any
		want int
		ok   bool
	}{
		{5, 5, true},
		{int64(7), 7, true},
		{float64(2.9), 2, true},
		{"3", 0, false},
		{nil, 0, false},
	} {
		got, ok := asInt(c.in)
		if got != c.want || ok != c.ok {
			t.Fatalf("asInt(%v) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func BenchmarkTruthy(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = truthy(true)
		_ = truthy("true")
	}
}

func BenchmarkAsInt(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, _ = asInt(float64(3.5))
		_, _ = asInt("x")
	}
}

func BenchmarkFallbackProjection(b *testing.B) {
	fields := []string{"_id", "name", "age", "email"}
	for i := 0; i < b.N; i++ {
		_ = fallbackProjection(fields)
	}
}
