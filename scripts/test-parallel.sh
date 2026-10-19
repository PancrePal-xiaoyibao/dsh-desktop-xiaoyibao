#!/usr/bin/env bash
#
# 并行测试脚本。 SPEC ADR-08 / 治理文档 §5.2。
#
# 为什么需要：宿主机有 20 核，串行跑测试等于浪费 19 核。
# 核数**动态探测**（不硬编码），保证在 CI（2 核）与开发机（20 核）之间通用。
#
# 用法：
# bash scripts/test-parallel.sh
# XYB_TEST_JOBS=16 bash scripts/test-parallel.sh
# XYB_TEST_SERIAL=1 bash scripts/test-parallel.sh # 串行逃生（调试用）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 动态探测可用核数：留 4 核给系统
if [ -n "${XYB_TEST_JOBS:-}" ]; then
  JOBS="$XYB_TEST_JOBS"
elif [ "${XYB_TEST_SERIAL:-0}" = "1" ]; then
  JOBS=1
elif command -v nproc >/dev/null 2>&1; then
  JOBS=$(( $(nproc) > 4 ? $(nproc) - 4 : 1 ))
elif command -v sysctl >/dev/null 2>&1; then
  CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
  JOBS=$(( CORES > 4 ? CORES - 4 : 1 ))
else
  JOBS=4
fi

echo "[xyb-test] 并行度 jobs=$JOBS（XYB_TEST_SERIAL=1 可串行）"

# 收集测试文件（三个插件包的 test/ 下）
# 扫描范围：**插件的 test/ 与仓库根的 test/** 都要收。
# 为什么加根级：跨包契约测试（如「插件入口可 import」）必须放在仓库根，
# 它不属于任何单个插件包。曾经只扫 packages/，导致这类测试被静默漏跑（实测踩坑）。
# ⚠️ 不要用 `-path '*/test/*'` —— 它要求 /test/ 前有内容，
# 根级 `test/contract/x.test.mjs` 以 test/ 开头，匹配不上（实测踩坑，静默漏跑）。
# 用「文件名后缀 + 排除 vendor/node_modules」更稳。
mapfile -t TEST_FILES < <(
  find packages test \
    -name '*.test.mjs' \
    -not -path '*/vendor/*' \
    -not -path '*/node_modules/*' \
    | sort
)

if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  echo "[xyb-test] 未找到测试文件"
  exit 0
fi

echo "[xyb-test] 共 ${#TEST_FILES[@]} 个测试文件"

# 并行执行：每个文件一个 node --test 进程
# 隔离保证（ADR-08）：每个测试自己用 os.tmpdir() 下的独立目录（见 test/helpers/temp.js）
FAILED=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run_one() {
  local file="$1"
  local name
  name="$(echo "$file" | tr '/' '_')"
  if node --test "$file" > "$TMP_DIR/$name.log" 2>&1; then
    echo "  ✅ $file"
  else
    echo "  ❌ $file"
    echo "EXIT_FAIL" >> "$TMP_DIR/failures"
    return 1
  fi
}
export -f run_one
export TMP_DIR

printf '%s\n' "${TEST_FILES[@]}" | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {} || true

if [ -f "$TMP_DIR/failures" ]; then
  FAILED=1
  echo ""
  echo "[xyb-test] 失败详情："
  # 失败日志**落盘保留**（.test-logs/）：闪失败（碰发/负载相关）如果日志被删，
  # 下一个人就完全无法定位 —— 实测踩过：一次并行跑里 onboarding-routes 闪红，
  # 因为 TMP_DIR 被 trap 清掉，只剩一句 “AssertionError”，无法复现也无法修。
  mkdir -p .test-logs
  for f in "${TEST_FILES[@]}"; do
    name="$(echo "$f" | tr '/' '_')"
    if grep -q "not ok\|✖" "$TMP_DIR/$name.log" 2>/dev/null; then
      cp "$TMP_DIR/$name.log" ".test-logs/$name.log" 2>/dev/null || true
      echo "─── $f ───"
      # 先抽 TAP 的失败块（用例名 + error 正文），再补最后 15 行（汇总/堆栈）
      awk '/^not ok/{show=14} show>0{print; show--}' "$TMP_DIR/$name.log" | head -24
      echo "      …（最后 15 行）"
      tail -15 "$TMP_DIR/$name.log" | sed 's/^/      /'
      echo "      完整日志：.test-logs/$name.log"
    fi
  done
fi

# 汇总统计
TOTAL_PASS=0
TOTAL_FAIL=0
for f in "${TEST_FILES[@]}"; do
  name="$(echo "$f" | tr '/' '_')"
  # ⚠️ node --test 的逐文件输出是 `# pass N`（TAP 风格）；旧实现只匹配 `ℹ pass N`，
  # 于是汇总永远是 pass=0 fail=0（实测踩坑：看起来像“没跑测试”）——两种都认。
  p=$(grep -oE '^(#|ℹ) pass [0-9]+' "$TMP_DIR/$name.log" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 0)
  fl=$(grep -oE '^(#|ℹ) fail [0-9]+' "$TMP_DIR/$name.log" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 0)
  TOTAL_PASS=$((TOTAL_PASS + ${p:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${fl:-0}))
done

echo ""
echo "[xyb-test] 汇总：pass=$TOTAL_PASS fail=$TOTAL_FAIL"

if [ "$FAILED" != "0" ] || [ "$TOTAL_FAIL" != "0" ]; then
  exit 1
fi
echo "[xyb-test] 全部通过"
