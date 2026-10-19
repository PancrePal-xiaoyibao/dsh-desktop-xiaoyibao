#!/usr/bin/env python3
"""
小胰宝临床试验智能订阅主控台
统一 CLI:抓取过滤 + 多渠道推送编排

核心能力已抽取到 lib/ 公共模块:
- lib.ctgov_api:      抓取(支持 china/top/latest 过滤)
- lib.channels.*:     推送渠道(telegram/gewe/feishu/fastgpt 独立可复用)

用法示例:
    # 10 个最近中国试验,卡片推送微信
    python3 main.py --10 --china --send-gewe-card

    # 等价简写
    python3 main.py --top 10 --china --channels gewe_card

    # 单一靶点(YAML 匹配别名) → GeWe 文字
    python3 main.py --target B7H3 --china --top 10 --send-gewe-txt

    # 全渠道推送当天试验
    python3 main.py --all-channels

    # 向后兼容:完整自动流程(抓取→翻译→FastGPT)
    python3 main.py --auto

    # 无参数:交互菜单
    python3 main.py
"""
import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# 全局配置
UPLOAD_MODE = "today"  # "today" 或 "all"

# 所有支持的渠道名
ALL_CHANNELS = ["tg", "gewe_card", "gewe_txt", "feishu", "fastgpt"]


def _make_cli_namespace(**overrides):
    """构造与 build_parser 字段对齐的 Namespace(快捷菜单复用)。"""
    defaults = dict(
        china=False,
        latest=True,
        top=None,
        condition=None,
        status=None,
        days_back=None,
        target=None,
        send_tg=False,
        send_gewe_card=False,
        send_gewe_txt=False,
        send_feishu=False,
        send_fastgpt=False,
        channels=None,
        no_channels=None,
        all_channels=False,
        auto=False,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def print_banner():
    print("\n" + "="*60)
    print("🏥 小胰宝临床试验智能订阅系统")
    print("="*60)
    print(f"当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60 + "\n")


# ============ 向后兼容:subprocess 调用(保留原有 run_step)============
def run_step(script_name, description, args=None):
    """通过 subprocess 调用脚本(向后兼容,供 auto_pipeline 和交互菜单使用)"""
    print(f"\n{'='*60}")
    print(f"▶️  {description}")
    print(f"{'='*60}\n")
    cmd = ["python3", script_name] + (args or [])
    try:
        subprocess.run(cmd, check=True, capture_output=False, text=True)
        print(f"\n✅ {description} - 完成\n")
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ {description} - 失败 (退出码: {e.returncode})\n")
        return False
    except Exception as e:
        print(f"\n❌ {description} - 异常: {e}\n")
        return False


def auto_pipeline():
    """自动执行完整流程:下载 → 翻译 → 上传(向后兼容 --auto)"""
    print_banner()
    print("📋 自动流程模式:执行完整订阅链路\n")

    steps = [
        ("daily_ctgov_check_tgbot.py", "步骤 1/3: 从 ClinicalTrials.gov 下载最新试验数据"),
        ("ctgov_full_sync_rag.py", "步骤 2/3: 全文翻译并生成 RAG 语料"),
        ("fastgpt_sync.py", f"步骤 3/3: 同步到 FastGPT (模式: {UPLOAD_MODE})", ["--once", f"--mode={UPLOAD_MODE}"])
    ]

    success_count = 0
    for script, desc, *extra_args in steps:
        args = extra_args[0] if extra_args else None
        if run_step(script, desc, args):
            success_count += 1
        else:
            print(f"\n⚠️  流程中断于: {desc}")
            break

    print(f"\n{'='*60}")
    print(f"📊 流程完成: {success_count}/{len(steps)} 步骤成功")
    print(f"{'='*60}\n")


# ============ CLI 参数解析 ============
def build_parser():
    """构建统一 CLI 参数解析器"""
    parser = argparse.ArgumentParser(
        description="小胰宝临床试验智能订阅系统 - 统一 CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  %(prog)s --10 --china --send-gewe-card          10 个最近中国试验,卡片推送微信
  %(prog)s --top 20 --china --channels tg,gewe_card   简写:多渠道
  %(prog)s --target B7H3 --china --top 10 --send-gewe-txt
                                                  单一靶点(YAML 别名匹配)→微信文字
  %(prog)s --all-channels                          全渠道推送当天试验
  %(prog)s --china --top 20                        仅抓取不推送(落地 JSON)
  %(prog)s --auto                                  完整自动流程(向后兼容)
  %(prog)s                                         无参数 → 交互菜单
""")

    # ---- 抓取过滤器 ----
    fetch_group = parser.add_argument_group("抓取过滤器")
    fetch_group.add_argument("--china", action="store_true",
                             help="仅抓取含中国中心的试验")
    fetch_group.add_argument("--latest", action="store_true", default=True,
                             help="按最近更新排序(默认开启)")
    fetch_group.add_argument("--top", type=int, metavar="N",
                             help="取前 N 个试验")
    # 支持 --10 / --20 这种简写(argparse 会解析为负数,需特殊处理)
    fetch_group.add_argument("--condition", type=str, default=None,
                             help="疾病条件(默认 Pancreatic Cancer)")
    fetch_group.add_argument("--status", type=str, default=None,
                             help="试验状态(默认 RECRUITING)")
    fetch_group.add_argument("--days-back", type=int, default=None,
                             help="时间窗天数(默认 30,0=不过滤)")
    fetch_group.add_argument(
        "--target", type=str, default=None, metavar="NAME",
        help="单一靶点(与 assets/pancreatic_targets.yaml 匹配; 支持别名/大小写,如 B7H3/CD276/CLDN18.2)",
    )

    # ---- 推送开关(正交)----
    push_group = parser.add_argument_group("推送开关(可组合)")
    push_group.add_argument("--send-tg", action="store_true", help="推送到 Telegram")
    push_group.add_argument("--send-gewe-card", action="store_true", help="推送 GeWe 卡片")
    push_group.add_argument("--send-gewe-txt", action="store_true", help="推送 GeWe 文字")
    push_group.add_argument("--send-feishu", action="store_true", help="推送到飞书")
    push_group.add_argument("--send-fastgpt", action="store_true", help="同步到 FastGPT")

    # ---- 多渠道简写 ----
    short_group = parser.add_argument_group("多渠道简写")
    short_group.add_argument("--channels", type=str, default=None,
                             help="逗号分隔的多渠道,如 tg,gewe_card,feishu")
    short_group.add_argument("--no-channels", type=str, default=None,
                             help="排除的渠道(逗号分隔),用于 --all-channels 时排除")
    short_group.add_argument("--all-channels", action="store_true",
                             help="开启所有渠道")

    # ---- 完整流程 ----
    parser.add_argument("--auto", action="store_true",
                        help="完整自动流程(抓取→翻译→FastGPT,向后兼容)")
    return parser


def resolve_channels(args):
    """
    合并 CLI 参数与 config.yaml 默认值,返回最终渠道列表。
    优先级:CLI 显式参数(--send-* / --channels / --all-channels) > config.yaml 默认
    委托给 lib.config.resolve_channels_from_args。
    """
    from lib.config import resolve_channels_from_args
    return resolve_channels_from_args(args)


def has_fetch_filters(args):
    """判断是否指定了任何抓取过滤器或推送渠道(用于区分 CLI 模式 vs 交互菜单)"""
    return (args.china or args.top is not None or args.condition or
            args.status or args.days_back is not None or
            getattr(args, "target", None) or args.channels or
            args.all_channels or args.send_tg or args.send_gewe_card or
            args.send_gewe_txt or args.send_feishu or args.send_fastgpt)


# ============ 推送调度(阶段2:各渠道从已生成 content 消费)============
def dispatch_push(channel, content):
    """
    将已生成的内容分发到指定渠道。
    content 来自 build_push_content() 的返回值,包含:
        studies / summary_msg / detail_groups / footer / study_details

    各渠道按需消费,互不耦合:
        tg       → summary_msg + detail_groups + footer(完整 TG 编排)
        gewe_txt → summary_msg + detail_groups + footer(转纯文本分批, TG 切片格式)
        gewe_card→ studies(逐个生成 appmsg 卡片)
        feishu   → studies(逐个生成飞书卡片)
        fastgpt  → 不直接用 content,而是从落地的 JSON 消费(RAG 翻译+同步)
    """
    studies = content["studies"]
    summary_msg = content["summary_msg"]
    detail_groups = content["detail_groups"]
    footer = content["footer"]
    total = len(studies)

    print(f"\n📤 推送到渠道: {channel}({total} 个试验)")
    try:
        if channel == "tg":
            from lib.channels.telegram import send_msg
            # TG 完整编排:汇总 → 分组详情 → footer
            send_msg(summary_msg)
            for detail in detail_groups:
                send_msg(detail)
            send_msg(footer)
            print(f"   TG: 汇总 + {len(detail_groups)} 组详情 + footer 已发送")

        elif channel == "gewe_txt":
            # GeWe 文字:用 TG 的切片格式(Markdown 转纯文本 + 按长度分批)
            # send_text 内部已做 markdown_to_plain + split_text_by_len
            from lib.channels.gewe import send_text
            send_text(summary_msg)
            for detail in detail_groups:
                send_text(detail)
            send_text(footer)
            print(f"   GeWe 文字: 汇总 + {len(detail_groups)} 组详情 + footer 已发送")

        elif channel == "gewe_card":
            # GeWe 卡片:逐个 study 生成 appmsg 卡片(需 --send-gewe-card 显式开启)
            from lib.channels.gewe import send_cards_batch
            ok = send_cards_batch(studies)
            print(f"   GeWe 卡片: {ok}/{total} 发送成功")

        elif channel == "feishu":
            # 飞书:逐个 study 生成交互式卡片
            from lib.channels.feishu import send_cards_batch
            ok = send_cards_batch(studies)
            print(f"   飞书卡片: {ok} 发送成功")

        elif channel == "fastgpt":
            # FastGPT:不消费 content,而是从落地的 JSON 消费
            # 第1步 RAG 翻译(pending JSON → cn/*-zh.md),第2步 同步到 FastGPT
            from lib.channels.fastgpt import run_rag_translation, send_to_fastgpt
            from lib.config import get_workflow_setting
            translate_first = get_workflow_setting("fastgpt_translate_first", True)
            if translate_first:
                print("   步骤 1/2: 全文翻译(RAG,pending JSON → cn/*-zh.md)...")
                run_rag_translation()
            print(f"   步骤 {'2/2' if translate_first else '1/1'}: 同步到 FastGPT (mode={UPLOAD_MODE})...")
            send_to_fastgpt(mode=UPLOAD_MODE)

        else:
            print(f"   ⚠️  未知渠道: {channel}")
    except Exception as e:
        print(f"   ❌ 渠道 {channel} 推送失败: {e}")


# ============ CLI 主流程(两阶段分离)============
def run_cli_mode(args):
    """
    CLI 模式:两阶段分离执行。
    阶段1:批量抓取 → 翻译 → 落地 JSON → 生成汇总/详情内容(build_push_content)
    阶段2:各推送渠道从已生成内容消费(dispatch_push)

    支持 --target: 与 assets/pancreatic_targets.yaml 匹配后,用该靶点 keywords 覆盖默认 KEYWORDS。
    """
    from lib.ctgov_api import fetch_studies, get_nct_id, has_china_center
    from lib.content_builder import build_push_content
    from lib.config import get_workflow_setting
    from lib.targets import resolve_target_query

    print_banner()

    # ---- 单一靶点解析(可选)----
    keywords = None
    target_label = None
    raw_target = getattr(args, "target", None)
    if raw_target:
        resolved = resolve_target_query(raw_target)
        keywords = resolved["keywords"]
        target_label = resolved["display_name"]
        if resolved["matched"]:
            t = resolved["target"] or {}
            print(
                f"🎯 靶点匹配: 输入「{resolved['query']}」→ "
                f"{target_label} [group={t.get('group')}, id={t.get('id')}]"
            )
            print(f"   检索词: {', '.join(keywords)}")
        else:
            print(f"⚠️  未在 YAML 命中「{raw_target}」,按原文检索: {', '.join(keywords)}")
            print("   提示: 可输入 B7H3 / CD276 / CLDN18.2 / Claudin 18.2 等别名")

    # ==================== 阶段1:抓取 + 翻译 + 落地 + 生成内容 ====================
    sort = "LastUpdatePostDate:desc" if args.latest else None
    scope = f", target={target_label}" if target_label else ""
    print(
        f"🔍 阶段1:抓取试验(condition={args.condition or '默认'}, "
        f"china={args.china}, top={args.top}, days_back={args.days_back}{scope})"
    )

    studies = fetch_studies(
        condition=args.condition,
        keywords=keywords,
        status=args.status,
        china_only=args.china,
        sort=sort,
        top=args.top,
        days_back=args.days_back,
    )
    print(f"   抓取到 {len(studies)} 个试验")

    if not studies:
        print("⚠️  未找到符合条件的试验")
        return

    # 显示抓取结果概要
    for i, s in enumerate(studies[:5], 1):
        nct = get_nct_id(s)
        marker = "🇨🇳 " if has_china_center(s) else ""
        title = s.get("protocolSection", {}).get("identificationModule", {}).get("briefTitle", "")[:40]
        print(f"   {i}. {marker}{nct} | {title}")
    if len(studies) > 5:
        print(f"   ... 共 {len(studies)} 个")

    # 一次性翻译 + 落地 JSON + 生成内容(不再单篇推送)
    # 未指定 --target 时,把默认 KEYWORDS 也带进日报「检索关键词」行
    if keywords is None:
        from lib.ctgov_api import _DEFAULT_KEYWORDS
        keywords = list(_DEFAULT_KEYWORDS)

    auto_save = get_workflow_setting("auto_save_json", True)
    print(f"\n🔄 阶段1:批量翻译 + 落地 JSON + 生成推送内容...")
    content = build_push_content(
        studies,
        auto_save_json=auto_save,
        condition=args.condition,
        keywords=keywords,
        target_label=target_label,
    )
    if not content:
        print("⚠️  内容生成失败")
        return
    print(f"   ✅ 翻译完成:{len(studies)} 个试验,生成 {len(content['detail_groups'])} 组详情")

    # ==================== 阶段2:各渠道推送 ====================
    channels = resolve_channels(args)
    if not channels:
        print(f"\n📋 阶段1完成(翻译+落地),未指定推送渠道。如需推送,加 --send-* / --channels / --all-channels")
        return

    print(f"\n📤 阶段2:推送到 {len(channels)} 个渠道: {', '.join(channels)}")
    for ch in channels:
        dispatch_push(ch, content)

    print(f"\n{'='*60}")
    done_target = f", 靶点={target_label}" if target_label else ""
    print(f"✅ 全部完成:阶段1 抓取翻译 {len(studies)} 个{done_target},阶段2 推送 {len(channels)} 个渠道")
    print(f"{'='*60}")


# ============ 交互菜单(向后兼容)============
def show_sync_status():
    """显示 FastGPT 同步状态"""
    print(f"\n{'='*60}")
    print("📊 FastGPT 同步状态")
    print(f"{'='*60}\n")

    state_file = Path("data/fastgpt_sync_state.json")
    if not state_file.exists():
        print("⚠️  状态文件不存在")
        return

    try:
        import json
        with open(state_file, 'r', encoding='utf-8') as f:
            state = json.load(f)
        files = state.get("files", {})
        print(f"✅ 已同步文件数: {len(files)}")
        recent = sorted(files.items(), key=lambda x: x[1].get('uploadTime', ''), reverse=True)[:5]
        if recent:
            print("\n最近同步:")
            for nct_id, info in recent:
                filename = info.get('filename', nct_id)
                upload_time = info.get('uploadTime', 'N/A')
                print(f"  - {filename}")
                print(f"    NCT: {nct_id}, 时间: {upload_time}")
    except Exception as e:
        print(f"❌ 读取状态失败: {e}")


def toggle_upload_mode():
    """切换上传模式"""
    global UPLOAD_MODE
    if UPLOAD_MODE == "today":
        UPLOAD_MODE = "all"
        print("\n✅ 已切换到: 全部含历史")
    else:
        UPLOAD_MODE = "today"
        print("\n✅ 已切换到: 仅当天")


def push_existing_report_menu():
    """推送已有报告的交互菜单"""
    from pathlib import Path
    
    print(f"\n{'='*60}")
    print("📤 推送已有报告")
    print(f"{'='*60}\n")
    
    # 查找可用的报告文件
    output_path = Path("output")
    if not output_path.exists():
        print("❌ output 目录不存在")
        return
    
    report_files = list(output_path.glob("*/telegram_push_report.txt"))
    if not report_files:
        print("❌ 未找到任何报告文件")
        return
    
    # 按修改时间排序
    report_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    
    # 显示可用的报告
    print("可用的报告文件:\n")
    print("0️⃣  最新报告 (自动选择)")
    for i, report_file in enumerate(report_files[:10], 1):  # 最多显示10个
        folder_name = report_file.parent.name
        mtime = datetime.fromtimestamp(report_file.stat().st_mtime).strftime('%Y-%m-%d %H:%M')
        print(f"{i}️⃣  {folder_name} ({mtime})")
    
    if len(report_files) > 10:
        print(f"... 还有 {len(report_files) - 10} 个报告")
    
    # 选择报告
    choice = input("\n请选择报告 [0-{}]: ".format(min(len(report_files), 10))).strip()
    
    try:
        choice_idx = int(choice)
        if choice_idx == 0:
            selected_file = report_files[0]
        elif 1 <= choice_idx <= min(len(report_files), 10):
            selected_file = report_files[choice_idx - 1]
        else:
            print("❌ 无效选项")
            return
    except ValueError:
        print("❌ 请输入数字")
        return
    
    print(f"\n✅ 已选择: {selected_file}")
    
    # 选择推送渠道
    print("\n请选择推送渠道:\n")
    print("1️⃣  Telegram")
    print("2️⃣  GeWe 文字")
    print("3️⃣  飞书")
    print("4️⃣  所有渠道 (Telegram + GeWe 文字 + 飞书)")
    print("5️⃣  自定义")
    
    channel_choice = input("\n请选择 [1-5]: ").strip()
    
    channel_args = []
    if channel_choice == "1":
        channel_args = ["--send-tg"]
    elif channel_choice == "2":
        channel_args = ["--send-gewe-txt"]
    elif channel_choice == "3":
        channel_args = ["--send-feishu"]
    elif channel_choice == "4":
        channel_args = ["--all-channels"]
    elif channel_choice == "5":
        custom = input("请输入渠道(逗号分隔,如 tg,gewe_txt,feishu): ").strip()
        if custom:
            channel_args = ["--channels", custom]
        else:
            print("❌ 未输入渠道")
            return
    else:
        print("❌ 无效选项")
        return
    
    # 执行推送
    cmd_args = ["--file", str(selected_file)] + channel_args
    run_step("push_existing_report.py", "推送已有报告", cmd_args)


def manual_menu():
    """手动菜单模式:单独执行各个步骤(向后兼容)"""
    while True:
        print_banner()
        print("📋 手动菜单模式\n")
        print(f"当前上传模式: {UPLOAD_MODE} ({'仅当天' if UPLOAD_MODE == 'today' else '全部含历史'})\n")
        print("1️⃣  下载最新临床试验 (daily_ctgov_check_tgbot.py)")
        print("2️⃣  全文翻译生成 RAG (ctgov_full_sync_rag.py)")
        print("3️⃣  同步到 FastGPT (fastgpt_sync.py --once)")
        print("4️⃣  查看 FastGPT 同步状态")
        print("5️⃣  切换上传模式 (当天/全部)")
        print("6️⃣  推送已有报告到各渠道")
        print("7️⃣  返回主菜单")
        print("0️⃣  退出系统")

        choice = input("\n请选择操作 [0-7]: ").strip()

        if choice == "1":
            run_step("daily_ctgov_check_tgbot.py", "下载最新临床试验")
        elif choice == "2":
            run_step("ctgov_full_sync_rag.py", "全文翻译生成 RAG")
        elif choice == "3":
            run_step("fastgpt_sync.py", f"同步到 FastGPT (模式: {UPLOAD_MODE})", ["--once", f"--mode={UPLOAD_MODE}"])
        elif choice == "4":
            show_sync_status()
        elif choice == "5":
            toggle_upload_mode()
        elif choice == "6":
            push_existing_report_menu()
        elif choice == "7":
            break
        elif choice == "0":
            print("\n👋 感谢使用小胰宝临床试验订阅系统！")
            sys.exit(0)
        else:
            print("❌ 无效选项，请重新选择")

        input("\n按回车键继续...")


def single_target_gewe_txt_menu():
    """
    单一靶点 → 抓取/翻译/推送 GeWe 文字。
    流程与选项 3 一致(默认 10 个最近中国中心试验),关键词由 YAML 靶点展开。
    """
    from lib.targets import format_targets_catalog, resolve_target_query

    print(f"\n{'='*60}")
    print("🎯 单一靶点 → 微信文字 (GeWe 文字)")
    print(f"{'='*60}\n")
    print("支持的靶点(assets/pancreatic_targets.yaml):")
    print(format_targets_catalog())
    print("\n提示: 大小写不敏感; 可用别名,如 b7h3 / CD276 / claudin18.2 / HER2 / ERBB2")
    print("      未命中 YAML 时仍按原文检索,不阻断流程。\n")

    raw = input("请输入靶点名称: ").strip()
    if not raw:
        print("❌ 未输入靶点")
        return

    resolved = resolve_target_query(raw)
    if not resolved["keywords"]:
        print("❌ 无法解析检索词")
        return

    if resolved["matched"]:
        t = resolved["target"] or {}
        print(
            f"\n✅ 已匹配: {resolved['display_name']} "
            f"[id={t.get('id')}, group={t.get('group')}]"
        )
        print(f"   检索词: {', '.join(resolved['keywords'])}")
    else:
        print(f"\n⚠️  未命中 YAML,将按原文「{raw}」检索")
        confirm = input("是否继续? [Y/n]: ").strip().lower()
        if confirm in {"n", "no"}:
            print("已取消")
            return

    # 可选: 条数 / 是否仅中国(默认对齐选项3)
    top_raw = input("取前 N 个试验 [默认 10]: ").strip()
    try:
        top_n = int(top_raw) if top_raw else 10
        if top_n <= 0:
            top_n = 10
    except ValueError:
        top_n = 10

    china_raw = input("仅含中国中心? [Y/n, 默认 Y]: ").strip().lower()
    china_only = china_raw not in {"n", "no"}

    print(
        f"\n▶️  开始: 靶点={resolved['display_name']}, top={top_n}, "
        f"china={china_only} → GeWe 文字"
    )
    args = _make_cli_namespace(
        china=china_only,
        latest=True,
        top=top_n,
        days_back=0,
        target=raw,
        send_gewe_txt=True,
    )
    run_cli_mode(args)


def interactive_menu():
    """顶层交互菜单(向后兼容,无参数时进入)"""
    print_banner()
    print("📋 主菜单\n")
    print("1️⃣  自动流程 (抓取 → 翻译 → 上传)")
    print("2️⃣  手动菜单 (单独执行各步骤)")
    print("3️⃣  快捷推送: 10 个最近中国试验 → 微信文字 (GeWe 文字)")
    print("4️⃣  快捷推送: 10 个最近中国试验 → 微信卡片 (需先在 config.yaml 开启 gewe_card)")
    print("5️⃣  单一靶点推送: 指定靶点 → 搜索/翻译 → 微信文字 (GeWe 文字)")
    print("0️⃣  退出")

    choice = input("\n请选择 [0-5]: ").strip()
    if choice == "1":
        auto_pipeline()
    elif choice == "2":
        manual_menu()
    elif choice == "3":
        # 快捷入口:复用 CLI 模式,推 GeWe 文字(TG 切片格式转纯文本,默认开启)
        args = _make_cli_namespace(
            china=True, latest=True, top=10, days_back=0, send_gewe_txt=True,
        )
        run_cli_mode(args)
    elif choice == "4":
        # 快捷入口:推 GeWe 卡片(appmsg 可跳转卡片)
        # ⚠️ 卡片默认关闭(channels.gewe_card=false),需用户先在 config.yaml 开启后使用。
        from lib.config import load_config
        if not load_config()["channels"].get("gewe_card", False):
            print("\n⚠️  微信卡片推送默认关闭。")
            print("   请先在 config.yaml 中设置 channels.gewe_card: true,")
            print("   或运行时加 --send-gewe-card 参数强制开启后重试。")
            return
        args = _make_cli_namespace(
            china=True, latest=True, top=10, days_back=0, send_gewe_card=True,
        )
        run_cli_mode(args)
    elif choice == "5":
        single_target_gewe_txt_menu()
    elif choice == "0":
        print("\n👋 感谢使用小胰宝临床试验订阅系统！")
        sys.exit(0)
    else:
        print("❌ 无效选项")


def parse_short_top(argv):
    """预处理 sys.argv:把 --10/--20 等转为 --top 10/--top 20"""
    processed = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        # 匹配 --<数字> 如 --10 --20
        if arg.startswith("--") and arg[2:].isdigit():
            processed.extend(["--top", arg[2:]])
        else:
            processed.append(arg)
        i += 1
    return processed


def main():
    """主入口:解析参数,路由到 CLI 模式 / 自动流程 / 交互菜单"""
    # 向后兼容:--auto 直接进自动流程
    if len(sys.argv) > 1 and sys.argv[1] == "--auto":
        auto_pipeline()
        return

    # 预处理 --10 等简写
    argv = parse_short_top(sys.argv[1:])

    # 无参数 → 交互菜单
    if not argv:
        interactive_menu()
        return

    parser = build_parser()
    args = parser.parse_args(argv)

    # --auto 标志
    if args.auto:
        auto_pipeline()
        return

    # 有任何过滤器或推送参数 → CLI 模式
    if has_fetch_filters(args):
        run_cli_mode(args)
    else:
        # 有参数但无实际操作(如只传 --latest)→ 显示帮助
        parser.print_help()


if __name__ == "__main__":
    main()
