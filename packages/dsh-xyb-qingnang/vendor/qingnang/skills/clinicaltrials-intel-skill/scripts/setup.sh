#!/usr/bin/env bash
# ============================================================
# clinicaltrials-intel skill - 一键部署脚本
# ============================================================
# 做四件事,让全新 clone 后一条命令完成可运行配置:
#   1. 创建虚拟环境 + 安装依赖(含主项目漏掉的 PyYAML)
#   2. 从模板生成 .env 与 config.yaml(到仓库根,与 lib/config.py 定位一致)
#   3. 创建运行时目录 output/ data/ cache/
#   4. 打印分级配置指引 + 调用 check_config.py
#
# 用法:
#   ./scripts/setup.sh           # 全新部署
#   ./scripts/setup.sh --deps    # 仅重装依赖
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "============================================================"
echo "🏥 clinicaltrials-intel skill 部署"
echo "============================================================"
echo "工作目录: $ROOT"
echo ""

# ------------------------------------------------------------
# 步骤 1: 虚拟环境 + 依赖
# ------------------------------------------------------------
echo "【1/4】创建虚拟环境并安装依赖..."
if [[ "${1:-}" != "--deps" ]]; then
    if [[ ! -d ".venv" ]]; then
        if command -v uv >/dev/null 2>&1; then
            echo "   使用 uv 创建虚拟环境..."
            uv venv --python 3.12 .venv
        else
            echo "   使用 python3 -m venv 创建虚拟环境..."
            python3 -m venv .venv
        fi
    else
        echo "   .venv 已存在,跳过创建。"
    fi
fi

# 选 pip:优先 venv 内的,再 uv,再系统 pip
PIP=""
if [[ -x ".venv/bin/pip" ]]; then
    PIP=".venv/bin/pip"
elif command -v uv >/dev/null 2>&1; then
    PIP="uv pip"   # uv pip 会自动用当前 venv
fi

if [[ -z "$PIP" ]]; then
    echo "   ⚠️  未找到 pip,请手动安装依赖: pip install -r requirements.txt"
else
    echo "   使用 $PIP 安装依赖..."
    if [[ "$PIP" == "uv pip" ]]; then
        uv pip install -r requirements.txt
    else
        "$PIP" install -r requirements.txt
    fi
    echo "   ✅ 依赖安装完成"
fi
echo ""

# ------------------------------------------------------------
# 步骤 2: 从模板生成配置(不覆盖已有配置)
# ------------------------------------------------------------
echo "【2/4】生成配置文件..."
gen_from_template() {
    local tpl="$1" dst="$2" name="$3"
    if [[ -f "$dst" ]]; then
        echo "   ⏭️  $name 已存在,跳过(如需重置请先删除)"
    elif [[ -f "$tpl" ]]; then
        cp "$tpl" "$dst"
        echo "   ✅ 已生成 $name(来自 $tpl)"
    else
        echo "   ⚠️  模板 $tpl 不存在,跳过 $name"
    fi
}
gen_from_template "assets/.env.template" ".env" ".env"
gen_from_template "assets/config.yaml.template" "config.yaml" "config.yaml"
echo ""

# ------------------------------------------------------------
# 步骤 3: 运行时目录
# ------------------------------------------------------------
echo "【3/4】创建运行时目录..."
for d in output data cache; do
    mkdir -p "$d"
    echo "   ✅ $d/"
done
echo ""

# ------------------------------------------------------------
# 步骤 4: 配置指引 + 校验
# ------------------------------------------------------------
echo "【4/4】配置状态检查..."
echo ""
cat <<'EOF'
============================================================
📋 接下来你要做的事(按需配置):
============================================================
🔴 启动必需:依赖已装好(本脚本已完成)
🟡 中文翻译:编辑 .env,至少填 1 个 LLM key(推荐 QWEN_API_KEY)
            不配也能跑,但推送内容是英文
🟢 推送渠道:按需配置,缺凭据的渠道会自动跳过
            - GeWe 微信: GEWE_ENABLED=true + APP_ID/TOKEN/TO_WXID
            - Telegram:  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
            - 飞书:      FEISHU_APP_ID + APP_SECRET + CHAT_IDS
            - FastGPT:   FASTGPT_BASE_URL + API_KEY + DATASET_ID

⚙️  编辑配置:nano .env  (或用你喜欢的编辑器)
🔍 校验配置:./scripts/check_config.py
🚀 运行:     python3 main.py
============================================================
EOF

echo "运行配置校验..."
PYTHON=".venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="python3"
"$PYTHON" scripts/check_config.py || true

echo ""
echo "✅ 部署完成。请编辑 .env 填入凭据后运行 python3 main.py"
