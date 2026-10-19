#!/usr/bin/env python3
"""
配置校验工具 - 检查 .env 与 config.yaml 是否满足运行条件

分级输出(🟢就绪 / 🟡降级 / 🔴缺失),不因配置不全而非零退出——
本系统设计为「缺配置静默跳过该渠道」,所以这里只报告、不阻断。

用法:
    python3 scripts/check_config.py
    python3 scripts/check_config.py --strict   # 有 🔴 时返回非零(用于 CI)
"""
import os
import sys
from pathlib import Path

# 从仓库根加载 .env(本脚本在 scripts/ 下,根是上一级)
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)  # 与 main.py 运行时一致,保证 load_dotenv 能找到根目录 .env

try:
    from dotenv import load_dotenv
    load_dotenv(override=True)  # override=True:让 .env 文件值覆盖已有环境变量,确保校验的是文件内容
except ImportError:
    print("⚠️  未安装 python-dotenv,直接读已存在的环境变量。")
    print("   请先运行: ./scripts/setup.sh")


def is_placeholder(value: str) -> bool:
    """判断值是否还是模板占位符(未填写真实值)"""
    if not value:
        return True
    v = value.strip().strip('"').strip("'")
    placeholders = {"your_", "your-", "changeme", "xxx", "placeholder",
                    "your_qwen_api_key_here", "your_fastgpt_api_key_here"}
    lower = v.lower()
    return any(lower == p or lower.startswith(p) for p in placeholders) or v == ""


def env(key: str) -> str:
    return os.getenv(key, "").strip()


def line(icon: str, msg: str):
    print(f"  {icon} {msg}")


def main():
    strict = "--strict" in sys.argv

    print("=" * 60)
    print("🔧 配置校验报告")
    print("=" * 60)

    env_file = ROOT / ".env"
    yaml_file = ROOT / "config.yaml"
    has_red = False

    # ---- 文件存在性 ----
    if not env_file.exists():
        line("🔴", ".env 不存在 → 请先运行 ./scripts/setup.sh 生成配置")
        print("\n提示: 生成后编辑 .env 填入真实凭据,再重新运行本检查。")
        return 1 if strict else 0
    if not yaml_file.exists():
        line("🔴", "config.yaml 不存在 → 请先运行 ./scripts/setup.sh 生成配置")
        return 1 if strict else 0
    line("🟢", ".env 与 config.yaml 均已生成")
    print()

    # ---- 🔴 依赖(致命:缺了 import 崩)----
    print("【🔴 启动依赖】(缺失会导致 import 崩溃)")
    missing_dep = []
    for mod in ("yaml", "requests", "dotenv", "openai", "apscheduler"):
        try:
            __import__(mod)
        except ImportError:
            missing_dep.append(mod)
    if missing_dep:
        line("🔴", f"缺少 Python 依赖: {', '.join(missing_dep)}")
        line("   ", "修复: ./scripts/setup.sh  或  uv pip install -r requirements.txt")
        has_red = True
    else:
        line("🟢", "核心依赖已安装")
    print()

    # ---- 🟡 LLM 翻译(缺则降级为英文输出)----
    print("【🟡 LLM 翻译】(至少配 1 个 key 才有中文翻译,否则输出英文)")
    llm_keys = {
        "QWEN_API_KEY": env("QWEN_API_KEY"),
        "ZHIPU_API_KEY": env("ZHIPU_API_KEY"),
        "STEP_API_KEY": env("STEP_API_KEY"),
        "GEMINI_API_KEY": env("GEMINI_API_KEY"),
    }
    configured = [name for name, val in llm_keys.items() if val and not is_placeholder(val)]
    if configured:
        line("🟢", f"已配置 LLM key: {', '.join(configured)}(主力: {configured[0]})")
    else:
        line("🟡", "未配置任何 LLM key → 翻译将降级为英文原文输出")
        line("   ", "推荐优先配置 QWEN_API_KEY(通义千问,申请: dashscope.console.aliyun.com)")
    print()

    # ---- 🟢 推送渠道(缺则该渠道静默跳过)----
    print("【🟢 推送渠道】(缺凭据的渠道会自动跳过,不影响其他渠道)")

    # Telegram
    tg_ok = env("TELEGRAM_BOT_TOKEN") and env("TELEGRAM_CHAT_ID")
    if tg_ok and not is_placeholder(env("TELEGRAM_BOT_TOKEN")):
        line("🟢", "Telegram  就绪")
    else:
        line("⚪", "Telegram  未配置(需 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)→ 推送时跳过")

    # GeWe
    gewe_enabled = env("GEWE_ENABLED").lower() in ("true", "1", "yes", "on")
    gewe_ok = (env("GEWE_APP_ID") and env("GEWE_TOKEN") and env("GEWE_TO_WXID")
               and not is_placeholder(env("GEWE_APP_ID")))
    if gewe_enabled and gewe_ok:
        line("🟢", "GeWe 微信 就绪")
    elif gewe_enabled and not gewe_ok:
        line("🟡", "GeWe 微信 已开启(GEWE_ENABLED=true)但凭据不全 → 推送时跳过")
    else:
        line("⚪", "GeWe 微信 未开启(GEWE_ENABLED 默认 false)→ 跳过")

    # 飞书
    feishu_ok = (env("FEISHU_APP_ID") and env("FEISHU_APP_SECRET") and env("FEISHU_CHAT_IDS")
                 and not is_placeholder(env("FEISHU_APP_ID")))
    if feishu_ok:
        line("🟢", "飞书      就绪")
    else:
        line("⚪", "飞书      未配置(需 FEISHU_APP_ID + APP_SECRET + CHAT_IDS)→ 推送时跳过")

    # FastGPT
    fg_ok = (env("FASTGPT_BASE_URL") and env("FASTGPT_API_KEY") and env("FASTGPT_DATASET_ID")
             and not is_placeholder(env("FASTGPT_API_KEY")))
    if fg_ok:
        line("🟢", "FastGPT   就绪")
    else:
        line("⚪", "FastGPT   未配置(需 BASE_URL + API_KEY + DATASET_ID)→ 同步时跳过")
    print()

    # ---- 汇总 ----
    print("=" * 60)
    if has_red:
        print("⛔ 存在 🔴 致命缺失,请先修复依赖再运行。")
    elif not configured:
        print("⚠️  可启动,但翻译会输出英文。配置至少 1 个 LLM key 后体验更佳。")
    else:
        print("✅ 配置就绪,可以运行 python3 main.py")
    print("=" * 60)
    return 1 if (strict and has_red) else 0


if __name__ == "__main__":
    sys.exit(main())
