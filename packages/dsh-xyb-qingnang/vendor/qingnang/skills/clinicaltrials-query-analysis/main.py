#!/usr/bin/env python3
"""
ClinicalTrials 搜索分析系统 — 交互式菜单入口。

提供三个核心功能：
  1. 单基因搜索      — 搜索指定基因的临床试验
  2. 多基因专题分析   — 批量搜索多个基因并对比
  3. NCCN 月报生成   — 生成本月胰腺癌临床月报
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# 添加脚本目录到路径
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

_SKILL_ROOT = _SCRIPT_DIR.parent

# 自动加载 .env 文件（如存在）
def _load_dotenv() -> None:
    """从 .env 文件加载环境变量（不覆盖已有的）。"""
    env_path = _SKILL_ROOT / ".env"
    if not env_path.exists():
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value

_load_dotenv()

from config_loader import load_config, get_all_genes, get_report_genes, get_genes_by_category
from search import ClinicalTrialsSearch, print_trials_table, print_summary
from report_nccn import generate_report
from translator import translate_fields


def print_header() -> None:
    """打印系统标题。"""
    print()
    print("=" * 60)
    print("  🔬 ClinicalTrials 搜索分析系统")
    print("  胰腺癌临床情报工具")
    print("=" * 60)
    print()


def print_menu() -> None:
    """打印主菜单。"""
    print("请选择功能：")
    print()
    print("  1. 单基因搜索      — 搜索指定基因的临床试验")
    print("  2. 多基因专题分析   — 批量搜索多个基因并对比")
    print("  3. NCCN 月报生成   — 生成本月胰腺癌临床月报")
    print("  4. 多格式报告导出  — 试验详情→MD/DOCX/PDF/XLSX/HTML 五种格式")
    print("  0. 退出")
    print()


def select_genes() -> list[dict]:
    """交互式选择基因。"""
    config = load_config()
    all_genes = get_all_genes(config)

    print("\n可用基因列表：")
    print()
    for i, gene in enumerate(all_genes, 1):
        report_mark = "📊" if gene.get("report") else "  "
        print(f"  {report_mark} {i:2d}. {gene['name']:<20s} [{gene['category']}] {gene.get('cn_name', '')}")

    print()
    print("  输入序号（逗号分隔，如 2,5,7）或输入基因名（如 kras,brca1）")
    print("  输入 'all' 选择全部, 'report' 选择月报默认基因")
    print("  输入 'q' 返回主菜单")
    print()

    choice = input("请选择: ").strip().lower()

    if choice == "q":
        return []
    if choice == "all":
        return all_genes
    if choice == "report":
        return get_report_genes(config)

    selected: list[dict] = []
    for part in choice.replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        # 按序号
        if part.isdigit():
            idx = int(part) - 1
            if 0 <= idx < len(all_genes):
                selected.append(all_genes[idx])
        else:
            # 按基因名/ID
            for g in all_genes:
                if part in (g["id"], g["name"].lower(), g["name"]):
                    selected.append(g)
                    break

    return selected


# ---------------------------------------------------------------------------
# 功能1：单基因搜索
# ---------------------------------------------------------------------------
async def single_gene_search() -> None:
    """单基因搜索交互。"""
    genes = select_genes()
    if not genes:
        return

    gene = genes[0]
    print(f"\n🔍 已选择: {gene['name']}（{gene.get('cn_name', '')}）")
    print(f"   搜索词: {gene.get('search_terms', [])}")
    print()

    # 可选参数
    country = input("国家筛选（回车跳过，如 China）: ").strip() or None
    days_input = input("过去天数（回车=不限）: ").strip()
    max_input = input("最大结果数（回车=50）: ").strip()

    start_date = None
    if days_input.isdigit():
        days = int(days_input)
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    max_results = int(max_input) if max_input.isdigit() else 50

    # 执行搜索
    print(f"\n⏳ 正在搜索 {gene['name']} ...\n")
    client = ClinicalTrialsSearch()
    try:
        all_trials = []
        seen_nct: set[str] = set()
        for term in gene.get("search_terms", [gene["name"]]):
            trials = await client.search(
                keyword=term,
                start_date=start_date,
                country=country,
                max_results=max_results,
            )
            for t in trials:
                if t["nct_id"] not in seen_nct:
                    all_trials.append(t)
                    seen_nct.add(t["nct_id"])
    finally:
        await client.aclose()

      # 输出
    # 双语翻译
    config = load_config()
    translations = translate_fields(
        items=all_trials,
        fields=["title", "conditions"],
        key_field="nct_id",
        domain="临床试验",
        config=config,
    )
    # 增强显示：在原始表格之后追加中文翻译摘要
    print_trials_table(all_trials)
    if translations:
        print(f"\n{'='*100}")
        print(f"  🌐 中文翻译（{len(translations)} 项）")
        print(f"{'='*100}\n")
        for t in all_trials:
            tr = translations.get(t.get("nct_id", ""), {})
            if tr.get("title"):
                print(f"  [{t['nct_id']}] {tr['title']}")
    print_summary(all_trials, gene["name"])

    input("\n按回车返回主菜单...")


# ---------------------------------------------------------------------------
# 功能2：多基因专题分析
# ---------------------------------------------------------------------------
async def multi_gene_analysis() -> None:
    """多基因批量搜索与对比。"""
    genes = select_genes()
    if not genes:
        return

    print(f"\n📊 已选择 {len(genes)} 个基因进行专题分析\n")

    country = input("国家筛选（回车跳过）: ").strip() or None
    max_results = 30

    print(f"\n⏳ 开始批量搜索 ...\n")

    results: dict[str, list] = {}
    client = ClinicalTrialsSearch()
    try:
        for i, gene in enumerate(genes, 1):
            print(f"  [{i}/{len(genes)}] {gene['name']} ...", end=" ", flush=True)
            all_trials = []
            seen_nct: set[str] = set()
            for term in gene.get("search_terms", [gene["name"]]):
                trials = await client.search(
                    keyword=term,
                    country=country,
                    max_results=max_results,
                )
                for t in trials:
                    if t["nct_id"] not in seen_nct:
                        all_trials.append(t)
                        seen_nct.add(t["nct_id"])
            results[gene["name"]] = all_trials
            print(f"{len(all_trials)} 项")
    finally:
        await client.aclose()

    # 对比分析
    config = load_config()

    print(f"\n{'='*80}")
    print(f"  📊 多基因专题分析报告")
    print(f"{'='*80}\n")

    print("| 基因 | 试验数 | 招募中 | 热门药物 | 热门国家 |")
    print("|------|--------|--------|---------|---------|")
    for gene_name, trials in results.items():
        total = len(trials)
        recruiting = sum(1 for t in trials if t.get("status") == "RECRUITING")
        from collections import Counter
        drugs = Counter(d for t in trials for d in t.get("drugs", []))
        countries = Counter(c for t in trials for c in t.get("countries", []))
        top_drug = drugs.most_common(1)[0][0] if drugs else "-"
        top_country = countries.most_common(1)[0][0] if countries else "-"
        print(f"| {gene_name} | {total} | {recruiting} | {top_drug} | {top_country} |")

    print()

    # 逐基因详情 + 双语翻译
    for gene_name, trials in results.items():
        translations = translate_fields(
            items=trials,
            fields=["title", "conditions"],
            key_field="nct_id",
            domain="临床试验",
            config=config,
        )
        print_trials_table(trials)
        if translations:
            print(f"  🌐 中文翻译（{len(translations)} 项）")
            for t in trials:
                tr = translations.get(t.get("nct_id", ""), {})
                if tr.get("title"):
                    print(f"    [{t['nct_id']}] {tr['title']}")
            print()
        print_summary(trials, gene_name)

    input("\n按回车返回主菜单...")


# ---------------------------------------------------------------------------
# 功能3：NCCN 月报
# ---------------------------------------------------------------------------
async def nccn_report() -> None:
    """生成月报。"""
    print("\n📋 NCCN 胰腺癌临床试验月报生成器\n")

    use_llm_input = input("是否启用 LLM 深度分析？(y/n, 默认y): ").strip().lower()
    use_llm = use_llm_input != "n"

    translate_input = input("是否启用试验标题翻译？(y/n, 默认n): ").strip().lower()
    translate = translate_input == "y"

    gene_filter = input("仅生成指定基因？(回车=全部月报基因, 或输入基因ID如 kras): ").strip() or None

    print()
    await generate_report(gene_filter=gene_filter, use_llm=use_llm, translate=translate)

    input("\n按回车返回主菜单...")


# ---------------------------------------------------------------------------
# 功能4：多格式报告导出
# ---------------------------------------------------------------------------
async def export_reports() -> None:
    """多格式报告导出（MD/DOCX/PDF/XLSX/HTML）。"""
    print("\n📑 多格式报告导出\n")

    # 检查数据文件是否存在
    enriched_json = os.path.join(_SKILL_ROOT, "outputs", "cldn18_2_enriched.json")
    if not os.path.exists(enriched_json):
        print("⏳ 尚未抓取试验详情数据，正在执行 fetch_details.py ...\n")
        ret = os.system(f"{sys.executable} {os.path.join(_SCRIPT_DIR, 'fetch_details.py')}")
        if ret != 0:
            print("\n❌ 数据抓取失败，请检查网络后重试。")
            input("\n按回车返回主菜单...")
            return

    print("⏳ 正在生成 5 种格式报告（MD / DOCX / PDF / XLSX / HTML）...\n")
    ret = os.system(f"{sys.executable} {os.path.join(_SCRIPT_DIR, 'generate_reports.py')}")
    if ret == 0:
        print("\n✅ 报告导出完成！请查看 outputs/CLDN18.2_RECRUITING/ 目录")
    else:
        print("\n❌ 报告生成失败，请检查依赖是否完整（openpyxl, python-docx, fpdf2）")

    input("\n按回车返回主菜单...")


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
async def main() -> None:
    """主循环。"""
    while True:
        print_header()
        print_menu()

        choice = input("请输入选项 [0-4]: ").strip()

        if choice == "0":
            print("\n👋 再见！\n")
            break
        elif choice == "1":
            await single_gene_search()
        elif choice == "2":
            await multi_gene_analysis()
        elif choice == "3":
            await nccn_report()
        elif choice == "4":
            await export_reports()
        else:
            print("\n⚠️ 无效选项，请重新输入。")
            await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 已退出。\n")
