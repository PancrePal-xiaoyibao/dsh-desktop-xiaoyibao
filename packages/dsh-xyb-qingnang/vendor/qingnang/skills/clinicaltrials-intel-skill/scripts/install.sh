#!/usr/bin/env bash
# ============================================================
# 安装/更新 clinicaltrails-intel skill 到默认技能目录 ~/.agents/skills
# ============================================================
# 用法：
#   ./scripts/install.sh          # 安装(软链接)
#   ./scripts/install.sh --copy   # 安装(复制,不跟随源更新)
#   ./scripts/install.sh --uninstall
#
# 默认软链接:更新本仓库即更新技能,无需重新安装。
set -euo pipefail

SKILL_NAME="clinicaltrials-intel"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/.agents/skills"
TARGET="$TARGET_DIR/$SKILL_NAME"

mkdir -p "$TARGET_DIR"

# 先清理已有安装(无论是软链接还是实体目录)
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if [ -L "$TARGET" ]; then
        echo "→ 移除已有软链接: $TARGET"
        rm "$TARGET"
    elif [ -d "$TARGET" ]; then
        echo "→ 移除已有目录: $TARGET"
        rm -rf "$TARGET"
    fi
fi

case "${1:-link}" in
    --copy)
        echo "→ 复制 $REPO_DIR → $TARGET"
        cp -R "$REPO_DIR" "$TARGET"
        ;;
    --uninstall)
        echo "✓ 已卸载 $SKILL_NAME"
        exit 0
        ;;
    link|"")
        echo "→ 软链接 $REPO_DIR → $TARGET"
        ln -s "$REPO_DIR" "$TARGET"
        ;;
    *)
        echo "未知参数: $1" >&2
        echo "用法: $0 [--copy|--uninstall]"
        exit 1
        ;;
esac

echo ""
echo "✓ $SKILL_NAME 已安装到 $TARGET"
echo "  重启 ZCode 会话后即可使用。"
