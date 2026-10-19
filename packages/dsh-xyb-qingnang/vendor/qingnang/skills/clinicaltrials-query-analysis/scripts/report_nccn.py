#!/usr/bin/env python3
"""
NCCN 胰腺癌临床试验月报生成器。

执行流程：
  1. 加载 genes.yaml 配置
  2. 确定时间窗口（过去30天）
  3. 逐基因搜索 → 缓存 JSON
  4. 汇总统计
  5. LLM 生成深度分析段落
  6. 组装最终报告

用法：
  python3 report_nccn.py                    # 生成月报
  python3 report_nccn.py --no-llm           # 跳过LLM，输出骨架
  python3 report_nccn.py --gene kras        # 仅生成单基因报告
  python3 report_nccn.py --translate        # 启用标题翻译（默认关闭，LLM分析已为中文）
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# 添加脚本目录到路径
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

# 路径常量
_SKILL_ROOT = _SCRIPT_DIR.parent
_CACHE_DIR = _SKILL_ROOT / "outputs" / "gene_cache"
_REPORT_DIR = _SKILL_ROOT / "outputs" / "reports"
_TEMPLATE_PATH = _SKILL_ROOT / "templates" / "report_nccn.md"

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
            # 不覆盖已有环境变量
            if key and key not in os.environ:
                os.environ[key] = value

_load_dotenv()

from config_loader import (
    load_config,
    get_report_genes,
    get_report_track_searches,
    get_llm_config,
    get_gene_by_id,
    get_llm_fallback_providers,
)
from search import ClinicalTrialsSearch
from translator import translate_fields

# 状态中文名
_STATUS_CN = {
    "RECRUITING": "招募中",
    "ACTIVE_NOT_RECRUITING": "暂停招募",
    "COMPLETED": "已完成",
    "TERMINATED": "已终止",
    "WITHDRAWN": "已撤回",
    "SUSPENDED": "暂停",
    "NOT_YET_RECRUITING": "尚未招募",
}

_STATUS_ICON = {
    "RECRUITING": "🟢",
    "ACTIVE_NOT_RECRUITING": "🟡",
    "COMPLETED": "✅",
    "TERMINATED": "🔴",
    "WITHDRAWN": "⚫",
    "SUSPENDED": "🟠",
    "NOT_YET_RECRUITING": "⚪",
}


# ---------------------------------------------------------------------------
# LLM 深度分析
# ---------------------------------------------------------------------------
def llm_analyze(prompt: str, config: dict[str, Any], use_llm: bool = True) -> str:
    """调用 LLM 生成深度分析段落。支持多 provider fallback。"""
    if not use_llm:
        return f"<!-- LLM 跳过。Prompt: {prompt[:100]}... -->"

    # 获取 fallback provider 列表
    fallback_providers = get_llm_fallback_providers(config)
    if not fallback_providers:
        # 无配置的 fallback，回退到旧版单 provider
        llm_cfg = get_llm_config(config)
        if not llm_cfg["api_key"]:
            return f"> ⚠️ 未配置 LLM API Key（provider={llm_cfg.get('provider','custom')}），深度分析段落待补充。\n> Prompt: {prompt[:80]}..."
        fallback_providers = [llm_cfg]

    try:
        from openai import OpenAI
    except ImportError:
        return "> ⚠️ openai 库未安装，请运行 pip install openai"

    errors = []
    runtime_cfg = get_llm_runtime_config(config)
    for idx, prov_cfg in enumerate(fallback_providers):
        try:
            client = OpenAI(
                api_key=prov_cfg["api_key"],
                base_url=prov_cfg["base_url"] or None,
                timeout=runtime_cfg["timeout"],
            )
            resp = client.chat.completions.create(
                model=prov_cfg["model"],
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"当前日期：{datetime.now().strftime('%Y年%m月%d日')}。"
                            "你是胰腺癌临床研究资深专家，擅长将临床试验数据转化为病友可理解的深度研究分析。"
                            "要求：1) 使用真实当前日期，严禁编造日期；"
                            "2) 专业、深入、数据驱动，避免空话套话；"
                            "3) 重点给出清晰可执行的指引；"
                            "4) 输出 Markdown 格式，500-800字；"
                            "5) 如数据不足，明确说明而非编造。"
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=prov_cfg.get("temperature", 0.4),
                max_tokens=prov_cfg.get("max_tokens", 2000),
            )
            result = (resp.choices[0].message.content or "").strip()
            if not result:
                raise ValueError("empty LLM response")
            # 如果用了后续 provider，打印提示
            if idx > 0:
                print(f"(fb{idx}:{prov_cfg['provider']})", end=" ", flush=True)
            return result
        except Exception as exc:
            err_msg = str(exc)[:60]
            errors.append(f"{prov_cfg['provider']}: {err_msg}")
            if idx < len(fallback_providers) - 1:
                print(f"⚠️{prov_cfg['provider']}失败→{fallback_providers[idx+1]['provider']}", end=" ", flush=True)
            continue

    return f"> ⚠️ LLM 全部 {len(fallback_providers)} 个 provider 调用失败: {'; '.join(errors)}"


# LLM 分析默认运行参数（可在 config/genes.yaml 的 llm 配置覆盖）
_LLM_CONCURRENCY = 2
_LLM_TIMEOUT = 120


def get_llm_runtime_config(config: dict[str, Any]) -> dict[str, int]:
    """获取 LLM 并发和超时参数，限制范围避免误配置导致接口雪崩。"""
    llm_cfg = config.get("llm", {})

    def _int_value(key: str, default: int) -> int:
        try:
            return int(llm_cfg.get(key, default))
        except (TypeError, ValueError):
            return default

    concurrency = max(1, min(_int_value("concurrency", _LLM_CONCURRENCY), 8))
    timeout = max(15, min(_int_value("timeout", _LLM_TIMEOUT), 180))
    return {"concurrency": concurrency, "timeout": timeout}


def llm_analyze_batch(
    tasks: list[tuple[str, str, dict[str, Any], bool]],
    concurrency: int | None = None,
) -> dict[str, str]:
    """
    并发执行多个 LLM 分析任务。

    Parameters
    ----------
    tasks : list of (task_id, prompt, config, use_llm)

    Returns
    -------
    dict[str, str]
        {task_id: llm_result}
    """
    results: dict[str, str] = {}
    max_workers = concurrency or _LLM_CONCURRENCY
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(llm_analyze, prompt, cfg, use_llm): task_id
            for task_id, prompt, cfg, use_llm in tasks
        }
        for future in as_completed(future_map):
            task_id = future_map[future]
            try:
                results[task_id] = future.result()
                print(f"✅({task_id})", end=" ", flush=True)
            except Exception as exc:
                results[task_id] = f"> ⚠️ 并发LLM失败: {exc}"
                print(f"❌({task_id})", end=" ", flush=True)
    print()
    return results


def genes_with_trials_for_llm(
    genes: list[dict[str, Any]],
    gene_data: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """拆分需要 LLM 分析的基因和无试验数据的跳过列表。"""
    included: list[dict[str, Any]] = []
    skipped: list[str] = []
    for gene in genes:
        if gene_data.get(gene["id"], []):
            included.append(gene)
        else:
            skipped.append(gene["id"])
    return included, skipped


def add_unique_trials(
    target: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> int:
    """按 NCT ID 合并试验，返回实际新增数量。"""
    seen = {trial.get("nct_id", "") for trial in target if trial.get("nct_id")}
    added = 0
    for trial in incoming:
        nct = trial.get("nct_id", "")
        if nct and nct not in seen:
            target.append(trial)
            seen.add(nct)
            added += 1
    return added


# ---------------------------------------------------------------------------
# 数据获取与缓存
# ---------------------------------------------------------------------------
async def fetch_gene_trials(
    gene: dict[str, Any],
    start_date: str,
    end_date: str,
    max_results: int = 50,
    use_cache: bool = True,
    cache_namespace: str = "gene",
) -> list[dict[str, Any]]:
    """搜索单个基因的临床试验，支持缓存。"""
    month_tag = datetime.now().strftime("%Y-%m")
    cache_file = _CACHE_DIR / f"{cache_namespace}_{gene['id']}_{month_tag}.json"
    legacy_cache_file = _CACHE_DIR / f"{gene['id']}_{month_tag}.json"

    # 检查缓存
    if use_cache and cache_file.exists():
        with open(cache_file, encoding="utf-8") as f:
            return json.load(f)
    if cache_namespace == "gene" and use_cache and legacy_cache_file.exists():
        with open(legacy_cache_file, encoding="utf-8") as f:
            return json.load(f)

    # 逐个 search_term 搜索并合并去重
    client = ClinicalTrialsSearch()
    all_trials: list[dict[str, Any]] = []
    seen_nct: set[str] = set()

    try:
        for term in gene.get("search_terms", []):
            trials = await client.search(
                keyword=term,
                start_date=start_date,
                end_date=end_date,
                max_results=max_results,
            )
            for t in trials:
                nct = t.get("nct_id", "")
                if nct and nct not in seen_nct:
                    t["_gene_id"] = gene["id"]
                    t["_gene_name"] = gene["name"]
                    all_trials.append(t)
                    seen_nct.add(nct)
    finally:
        await client.aclose()

    # 写入缓存
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(all_trials, f, ensure_ascii=False, indent=2)

    return all_trials


# ---------------------------------------------------------------------------
# 统计汇总
# ---------------------------------------------------------------------------
def compute_stats(trials: list[dict[str, Any]]) -> dict[str, Any]:
    """计算试验统计。"""
    status_counter = Counter(t.get("status", "Unknown") for t in trials)
    phase_counter = Counter(t.get("phase", "Not specified") for t in trials)

    # Biomarker 分布
    biomarker_counter: Counter[str] = Counter()
    for t in trials:
        bm = t.get("biomarker", "")
        if bm:
            for b in bm.split(", "):
                biomarker_counter[b] += 1

    # 药物分布
    drug_counter: Counter[str] = Counter()
    for t in trials:
        for drug in t.get("drugs", []):
            drug_counter[drug] += 1

    # 国家分布
    country_counter: Counter[str] = Counter()
    for t in trials:
        for c in t.get("countries", []):
            country_counter[c] += 1

    # 申办方分布
    sponsor_counter: Counter[str] = Counter()
    for t in trials:
        sp = t.get("sponsor", "")
        if sp:
            sponsor_counter[sp] += 1

    return {
        "total": len(trials),
        "status": dict(status_counter.most_common()),
        "phase": dict(phase_counter.most_common()),
        "biomarker": dict(biomarker_counter.most_common(15)),
        "drug": dict(drug_counter.most_common(15)),
        "country": dict(country_counter.most_common(10)),
        "sponsor": dict(sponsor_counter.most_common(10)),
    }


def stats_to_table(stats: dict[str, Any]) -> str:
    """将统计转为 Markdown 表格。"""
    lines = []

    lines.append("| 指标 | 数值 |")
    lines.append("|------|------|")
    lines.append(f"| 试验总数 | {stats['total']} |")
    lines.append(f"| 招募中 | {stats['status'].get('RECRUITING', 0)} |")
    lines.append(f"| 暂停招募 | {stats['status'].get('ACTIVE_NOT_RECRUITING', 0)} |")
    lines.append(f"| 涉及国家 | {len(stats['country'])} |")
    lines.append(f"| 涉及药物 | {len(stats['drug'])} |")
    lines.append("")

    lines.append("**招募状态分布：**")
    lines.append("")
    for status, count in stats["status"].items():
        cn = _STATUS_CN.get(status, status)
        icon = _STATUS_ICON.get(status, "❓")
        bar = "█" * count
        lines.append(f"- {icon} {cn} ({status}): {count} {bar}")
    lines.append("")

    lines.append("**临床阶段分布：**")
    lines.append("")
    for phase, count in stats["phase"].items():
        bar = "█" * count
        lines.append(f"- {phase}: {count} {bar}")
    lines.append("")

    lines.append("**热门靶点 Top 10：**")
    lines.append("")
    for bm, count in list(stats["biomarker"].items())[:10]:
        bar = "█" * count
        lines.append(f"- {bm}: {count} {bar}")
    lines.append("")

    lines.append("**热门药物 Top 10：**")
    lines.append("")
    for drug, count in list(stats["drug"].items())[:10]:
        lines.append(f"- {drug}: {count}")
    lines.append("")

    lines.append("**地区分布 Top 10：**")
    lines.append("")
    for c, count in list(stats["country"].items())[:10]:
        lines.append(f"- {c}: {count}")
    lines.append("")

    return "\n".join(lines)


def summarize_trials_for_prompt(trials: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    """压缩试验字段，作为 LLM prompt 的可追溯数据线索。"""
    summary = []
    for t in trials[:limit]:
        summary.append({
            "nct_id": t.get("nct_id"),
            "title": t.get("title", "")[:90],
            "phase": t.get("phase"),
            "status": t.get("status"),
            "drugs": t.get("drugs", [])[:4],
            "biomarker": t.get("biomarker", ""),
            "sponsor": t.get("sponsor"),
            "countries": t.get("countries", [])[:3],
            "start_date": t.get("start_date"),
        })
    return summary


# ---------------------------------------------------------------------------
# 基因专区生成
# ---------------------------------------------------------------------------
def format_gene_section(
    gene: dict[str, Any],
    trials: list[dict[str, Any]],
    llm_content: str,
    translations: dict[str, dict[str, str]] | None = None,
) -> str:
    """生成单个基因的分析专区。支持双语显示和日期字段。"""
    stats = compute_stats(trials)
    translations = translations or {}

    lines = []
    lines.append(f"### {gene['name']}（{gene.get('cn_name', '')}）")
    lines.append("")
    lines.append(f"> {gene.get('cn_desc', '')}")
    lines.append("")

    if not trials:
        lines.append("⚠️ 本月未检索到相关试验。")
        lines.append("")
        return "\n".join(lines)

    # 统计概要
    lines.append(f"- **试验数**：{stats['total']} 项 | **招募中**：{stats['status'].get('RECRUITING', 0)} 项")
    if stats["biomarker"]:
        top_bm = list(stats["biomarker"].items())[:3]
        bm_str = ", ".join(f"{bm}({cnt})" for bm, cnt in top_bm)
        lines.append(f"- **Biomarker**：{bm_str}")
    if stats["drug"]:
        top_drugs = list(stats["drug"].items())[:3]
        drug_str = ", ".join(f"{d}({cnt})" for d, cnt in top_drugs)
        lines.append(f"- **热门药物**：{drug_str}")
    lines.append("")

    # 临床清单（双语 + 日期）
    lines.append("| NCT ID | 标题（中/英） | 阶段 | 状态 | 药物 | 国家 | 📅发布 | 📅更新 |")
    lines.append("|--------|---------------|------|------|------|------|--------|--------|")
    for t in trials[:15]:
        nct = t.get("nct_id", "")
        title_en = t.get("title", "")[:45]
        # 中文标题
        tr = translations.get(nct, {})
        title_cn = tr.get("title", "")
        if title_cn:
            title_display = f"{title_cn}<br/>{title_en}"
        else:
            title_display = title_en
        phase = t.get("phase", "")
        status_cn = _STATUS_CN.get(t.get("status", ""), t.get("status", ""))
        drugs = ", ".join(t.get("drugs", [])[:2])
        countries = ", ".join(t.get("countries", [])[:2])
        first_post = t.get("first_post_date", "")
        last_update = t.get("last_update", "")
        lines.append(
            f"| [{nct}]({t.get('url', '')}) | {title_display} | {phase} | {status_cn} | {drugs} | {countries} | {first_post} | {last_update} |"
        )

    if len(trials) > 15:
        lines.append(f"| ... | *还有 {len(trials) - 15} 项* | | | | | | |")
    lines.append("")

    # LLM 深度分析
    lines.append("**📊 深度分析：**")
    lines.append("")
    lines.append(llm_content)
    lines.append("")

    return "\n".join(lines)


def format_trial_list_all(
    all_trials: list[dict[str, Any]],
    translations: dict[str, dict[str, str]] | None = None,
) -> str:
    """生成全部试验的合并清单。支持双语显示和日期字段。"""
    if not all_trials:
        return "本月无匹配试验。"

    translations = translations or {}

    # 按 gene_name 分组
    by_gene: dict[str, list[dict[str, Any]]] = {}
    for t in all_trials:
        gene_name = t.get("_gene_name", "其他")
        by_gene.setdefault(gene_name, []).append(t)

    lines = []
    for gene_name, trials in by_gene.items():
        lines.append(f"#### {gene_name}（{len(trials)} 项）")
        lines.append("")
        lines.append("| NCT ID | 标题（中/英） | 阶段 | 状态 | 国家 | 📅发布 | 📅更新 |")
        lines.append("|--------|---------------|------|------|------|--------|--------|")
        for t in trials[:10]:
            nct = t.get("nct_id", "")
            title_en = t.get("title", "")[:35]
            tr = translations.get(nct, {})
            title_cn = tr.get("title", "")
            if title_cn:
                title_display = f"{title_cn}<br/>{title_en}"
            else:
                title_display = title_en
            phase = t.get("phase", "")
            status_cn = _STATUS_CN.get(t.get("status", ""), "")
            countries = ", ".join(t.get("countries", [])[:2])
            first_post = t.get("first_post_date", "")
            last_update = t.get("last_update", "")
            lines.append(
                f"| [{nct}]({t.get('url', '')}) | {title_display} | {phase} | {status_cn} | {countries} | {first_post} | {last_update} |"
            )
        if len(trials) > 10:
            lines.append(f"| ... | *+{len(trials) - 10} 项* | | | | | |")
        lines.append("")

    return "\n".join(lines)


def _md_table_cell(value: Any) -> str:
    """转义 Markdown 表格单元格，避免竖线打断表格。"""
    text = str(value or "")
    return text.replace("|", r"\|").replace("\n", "<br/>")


def _md_table_row(values: list[Any]) -> str:
    return "| " + " | ".join(_md_table_cell(v) for v in values) + " |"


def format_glossary(genes: list[dict[str, Any]]) -> str:
    """生成医学术语速查表。"""
    lines = ["| 缩写 | 全称 | 作用 |", "|------|------|------|"]
    for g in genes:
        name = g["name"]
        cn_name = g.get("cn_name", "")
        cn_desc = g.get("cn_desc", "")
        lines.append(_md_table_row([name, cn_name, cn_desc]))
    # 通用术语
    common_terms = [
        ["ADC", "抗体偶联药物", "抗体+毒素的精准制导导弹"],
        ["PARP", "多聚ADP核糖聚合酶", "DDR靶向，合成致死策略"],
        ["ATR", "ATM和Rad3相关激酶", "DDR靶向，合成致死策略"],
        ["PROTAC", "蛋白水解靶向嵌合体", "降解靶蛋白的分子胶"],
        ["SHP2", "含SH2结构域蛋白酪氨酸磷酸酶", "RAS/MAPK通路"],
        ["CAR-T", "嵌合抗原受体T细胞", "基因工程免疫细胞疗法"],
        ["TCR-T", "T细胞受体工程T细胞", "靶向特定突变蛋白"],
        ["DDR", "DNA损伤反应", "细胞修复DNA的系统"],
        ["HRD", "同源重组缺陷", "PARP抑制剂敏感标志"],
        ["ICI", "免疫检查点抑制剂", "PD-1/PD-L1/CTLA-4抗体"],
    ]
    lines.extend(_md_table_row(term) for term in common_terms)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
async def generate_report(
    gene_filter: str | None = None,
    use_llm: bool = True,
    translate: bool = False,
    use_cache: bool = True,
    llm_concurrency: int | None = None,
) -> str:
    """生成月报主流程。"""
    config = load_config()
    runtime_cfg = get_llm_runtime_config(config)
    if llm_concurrency is not None:
        runtime_cfg["concurrency"] = max(1, min(llm_concurrency, 8))

    # 确定基因列表
    if gene_filter:
        gene = get_gene_by_id(gene_filter, config)
        if not gene:
            return f"错误：基因 '{gene_filter}' 未在配置中找到"
        genes = [gene]
    else:
        genes = get_report_genes(config)
    track_searches = [] if gene_filter else get_report_track_searches(config)

    # 时间窗口（过去30天）
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    month_label = datetime.now().strftime("%Y年%m月")

    print(f"📋 月报生成开始")
    print(f"   时间窗口: {start_date} ~ {end_date}")
    print(f"   基因数量: {len(genes)}")
    print(f"   LLM 分析: {'启用' if use_llm else '禁用'}")
    if use_llm:
        print(f"   LLM 并发/超时: {runtime_cfg['concurrency']} / {runtime_cfg['timeout']}s")
    print(f"   标题翻译: {'启用' if translate else '禁用（LLM分析已为中文）'}")
    print(f"   搜索缓存: {'启用' if use_cache else '禁用'}")
    print()

    # Step 1: 逐基因搜索
    print("🔍 Step 1: 逐基因搜索 ClinicalTrials.gov ...")
    gene_data: dict[str, list[dict[str, Any]]] = {}
    track_data: dict[str, list[dict[str, Any]]] = {}
    all_trials: list[dict[str, Any]] = []

    for i, gene in enumerate(genes, 1):
        print(f"   [{i}/{len(genes)}] {gene['name']} ...", end=" ", flush=True)
        trials = await fetch_gene_trials(
            gene,
            start_date,
            end_date,
            max_results=50,
            use_cache=use_cache,
        )
        gene_data[gene["id"]] = trials
        all_trials.extend(trials)
        print(f"{len(trials)} 项")
        # 避免触发 API 速率限制：每个基因搜索间隔 1-2 秒
        if i < len(genes):
            delay = 1.0 if use_cache else 2.0  # 无缓存时稍长间隔
            await asyncio.sleep(delay)

    if track_searches:
        print("\n🔬 Step 1.5: 技术赛道补充搜索 ...")
        for i, track in enumerate(track_searches, 1):
            print(f"   [{i}/{len(track_searches)}] {track['name']} ...", end=" ", flush=True)
            trials = await fetch_gene_trials(
                track,
                start_date,
                end_date,
                max_results=50,
                use_cache=use_cache,
                cache_namespace="track",
            )
            track_data[track["id"]] = trials
            added = add_unique_trials(all_trials, trials)
            print(f"{len(trials)} 项（新增 {added} 项）")
            # 避免触发 API 速率限制：每个赛道搜索间隔 1-2 秒
            if i < len(track_searches):
                delay = 1.0 if use_cache else 2.0  # 无缓存时稍长间隔
                await asyncio.sleep(delay)

    print(f"\n   ✅ 共检索到 {len(all_trials)} 项试验\n")

    # Step 2: 总体统计
    print("📊 Step 2: 生成总体统计 ...")
    overall_stats = compute_stats(all_trials)
    stats_table = stats_to_table(overall_stats)
    print("   ✅ 完成\n")

    # Step 2.5: 双语翻译（可选，默认关闭——LLM深度分析已输出中文）
    translations: dict[str, dict[str, str]] = {}
    if translate:
        print("🌐 Step 2.5: 双语翻译试验标题 ...")
        translations = translate_fields(
            items=all_trials,
            fields=["title"],
            key_field="nct_id",
            domain="临床试验",
            config=config,
            use_llm=use_llm,
        )
        print(f"   ✅ 已翻译 {len(translations)}/{len(all_trials)} 项试验\n")
    else:
        print("🌐 Step 2.5: 标题翻译已跳过（LLM分析已为中文）\n")

    # Step 3: LLM 深度分析
    print(f"🤖 Step 3: LLM 深度分析（{runtime_cfg['concurrency']}并发）...")

    # 准备数据摘要给 LLM
    now_str = datetime.now().strftime("%Y年%m月%d日")
    data_summary = json.dumps({
        "报告日期": now_str,
        "时间窗口": f"{start_date} ~ {end_date}",
        "total_trials": len(all_trials),
        "gene_count": len(genes),
        "status_dist": overall_stats["status"],
        "top_biomarkers": list(overall_stats["biomarker"].items())[:8],
        "top_drugs": list(overall_stats["drug"].items())[:8],
        "top_countries": list(overall_stats["country"].items())[:8],
        "top_sponsors": list(overall_stats["sponsor"].items())[:5],
        "phase_dist": overall_stats["phase"],
    }, ensure_ascii=False, indent=2)

    # 构建所有 LLM 任务（task_id, prompt）
    llm_tasks: list[tuple[str, str, dict[str, Any], bool]] = []

    # 3.1 总体分析
    llm_tasks.append((
        "overview",
        f"【当前日期：{now_str}】基于以下胰腺癌临床试验数据，生成本月概览深度分析（500-800字）：\n\n{data_summary}\n\n"
        "分析维度：\n"
        "1. 总体趋势：本月试验数量、招募状态分布反映的研发热度\n"
        "2. 靶点格局：哪些靶点最活跃、新兴靶点趋势\n"
        "3. 药物管线：创新药 vs 仿制药/联合用药的比例\n"
        "4. 地区分布：全球布局重心、中国参与度\n"
        "5. 阶段分布：早期 vs 中后期的比例，反映管线成熟度\n"
        "6. 与行业大趋势的对比（如KRAS从不可成药到靶向突破）\n"
        "要求：数据驱动、有观点、给出病友可参考的判断。严禁编造日期。",
        config, use_llm,
    ))

    # 3.2 逐基因分析 — 预构建 prompt
    gene_prompts: dict[str, str] = {}
    genes_for_llm, skipped_empty_genes = genes_with_trials_for_llm(genes, gene_data)
    for gene in genes_for_llm:
        trials = gene_data.get(gene["id"], [])
        gene_stats = compute_stats(trials)
        gene_summary = json.dumps({
            "基因": gene["name"],
            "中文名": gene.get("cn_name", ""),
            "试验数": len(trials),
            "top_drugs": list(gene_stats["drug"].items())[:5],
            "top_biomarkers": list(gene_stats["biomarker"].items())[:5],
            "status": gene_stats["status"],
            "countries": list(gene_stats["country"].items())[:5],
            "sponsors": list(gene_stats["sponsor"].items())[:3],
            "代表试验": summarize_trials_for_prompt(trials, limit=5),
        }, ensure_ascii=False, indent=2)

        prompt = (
            f"【当前日期：{now_str}】深度分析 {gene['name']}（{gene.get('cn_name','')}）靶点的胰腺癌临床试验现状（500-800字）：\n\n"
            f"基因说明：{gene.get('cn_desc','')}\n"
            f"数据：\n{gene_summary}\n\n"
            "分析维度：\n"
            "1. 本月新进展：新启动试验、阶段跃迁、关键数据读出\n"
            "2. 药物管线分析：各药物机制分类（小分子/ADC/细胞疗法等）、创新程度\n"
            "3. 阶段分布解读：早期探索 vs 确证性试验的比例\n"
            "4. 申办方格局：大药厂 vs Biotech、中国参与\n"
            "5. 临床意义：对携带该靶点突变的胰腺癌患者意味着什么\n"
            "6. 与同类靶点的差异化定位\n"
            "要求：具体到药物名和试验编号，给出可操作的判断。严禁编造日期和数据。"
        )
        gene_prompts[gene["id"]] = prompt
        llm_tasks.append((f"gene_{gene['id']}", prompt, config, use_llm))

    # 3.3 技术赛道分析
    tracks = [
        ("ras", "RAS 抑制剂赛道",
         "深度分析 RAS 抑制剂赛道进展（500-800字）。覆盖：\n"
         "- KRAS G12D/G12C/G12V 各亚型抑制剂进展（Zoldonrasib/VS-7375/GFH375/HRS-4642 等）\n"
         "- 三复合物抑制剂（RMC-5127/daraxonrasib）vs 共价抑制剂\n"
         "- RAS(ON)/RAS(OFF) 策略差异\n"
         "- 联合用药趋势（+EGFR/+化疗/+SHP2）\n"
         "- 中国国产管线进展"),
        ("adc", "ADC 药物赛道",
         "深度分析 ADC 药物赛道进展（500-800字）。覆盖：\n"
         "- 胰腺癌 ADC 靶点全景（TROP2/TF/Nectin-4/CEACAM5/CDH17/CLDN18.2/B7-H3）\n"
         "- 各靶点的 ADC 管线和阶段\n"
         "- linker/payload 技术迭代趋势\n"
         "- 与化疗联用策略\n"
         "- 中国 ADC 研发竞争力"),
        ("immune", "免疫治疗赛道",
         "深度分析免疫治疗进展（500-800字）。覆盖：\n"
         "- CAR-T（MSLN/B7-H3 靶点）在胰腺癌的挑战与突破\n"
         "- TCR-T 靶向 KRAS 突变的进展\n"
         "- mRNA 个性化新抗原疫苗的中国进展\n"
         "- ICI（PD-1/CTLA-4）在胰腺癌的困境与联合策略\n"
         "- 肿瘤微环境屏障的克服策略"),
        ("ddr", "DDR 靶向赛道",
         "深度分析 DDR 靶向赛道进展（500-800字）。覆盖：\n"
         "- PARP 抑制剂（奥拉帕利）在 BRCA 突变胰腺癌的既得阵地\n"
         "- ATR 抑制剂（Tuvusertib/Elimusertib/Ceralasertib）的合成致死策略\n"
         "- ATM 缺失作为生物标志物的临床应用\n"
         "- DDR + 免疫联合的机制基础\n"
         "- HRD 检测的标准化进展"),
        ("protac", "PROTAC 降解剂赛道",
         "深度分析 PROTAC 降解剂在胰腺癌的进展（500-800字）。覆盖：\n"
         "- KRAS PROTAC（ARV-806 等）的设计原理\n"
         "- PROTAC vs 小分子抑制剂的优势\n"
         "- 临床转化挑战（口服生物利用度/脱靶）\n"
         "- 全球管线竞争格局"),
        ("shp2", "SHP2 抑制剂赛道",
         "深度分析 SHP2 抑制剂赛道进展（500-800字）。覆盖：\n"
         "- SHP2 在 RAS/MAPK 通路的角色\n"
         "- 联合 KRAS 抑制剂的协同机制\n"
         "- 临床管线（TNO155/RMC-4630 等）\n"
         "- 单药 vs 联用的剂量优化策略"),
    ]

    for track_id, track_name, prompt_hint in tracks:
        track_trials = track_data.get(track_id, [])
        track_summary = json.dumps({
            "赛道": track_name,
            "补充检索试验数": len(track_trials),
            "代表试验": summarize_trials_for_prompt(track_trials),
        }, ensure_ascii=False, indent=2)
        llm_tasks.append((
            f"track_{track_id}",
            f"【当前日期：{now_str}】{prompt_hint}\n\n"
            f"本月试验数据参考：\n{data_summary}\n\n"
            f"本赛道补充检索数据：\n{track_summary}\n\n"
            "要求：结合本月实际数据，给出有数据支撑的分析，不要泛泛而谈。严禁编造日期和药物名。",
            config, use_llm,
        ))

    # 3.4 中国可及性 + 里程碑
    china_trials = [t for t in all_trials if "China" in t.get("countries", [])]
    china_details = []
    for t in china_trials[:5]:
        china_details.append({
            "nct_id": t.get("nct_id"),
            "title": t.get("title", "")[:60],
            "drugs": t.get("drugs", [])[:2],
            "sponsor": t.get("sponsor"),
        })
    china_summary = json.dumps({
        "中国试验数": len(china_trials),
        "中国靶点分布": list(Counter(t.get("_gene_name", "") for t in china_trials).most_common(5)),
        "中国试验详情": china_details,
    }, ensure_ascii=False, indent=2)

    llm_tasks.append((
        "china",
        f"【当前日期：{now_str}】深度分析胰腺癌临床试验的中国可及性（500-800字）：\n{china_summary}\n\n"
        "分析维度：\n"
        "1. 中国开展试验数量和靶点分布\n"
        "2. 国产创新药进展（HRS-4642/GFH375/ABO2102/IMP9064/TCC1727 等）\n"
        "3. 中国患者入组可及性（地域/费用/医保）\n"
        "4. NMPA 审评进度 vs FDA 的差距\n"
        "5. 对中国病友的实际就医建议\n"
        "严禁编造日期和审批信息。",
        config, use_llm,
    ))

    llm_tasks.append((
        "milestones",
        f"【当前日期：{now_str}】列出本月胰腺癌临床试验的重要里程碑（500-800字）：\n{data_summary}\n\n"
        "重点关注：\n"
        "1. 3期试验启动/数据读出/发布\n"
        "2. FDA/NMPA/EMA 批准或受理\n"
        "3. 关键 II 期数据公布\n"
        "4. 新药首次人体试验（FIC）\n"
        "5. 专利/授权/并购事件\n"
        "6. 暂停/终止试验的原因分析\n"
        "要求：如本月无重大里程碑，明确说明'本月无重大里程碑事件'，不要编造。结合数据中可观察到的线索分析。",
        config, use_llm,
    ))

    # 并发执行所有 LLM 任务
    total_tasks = len(llm_tasks)
    if skipped_empty_genes:
        print(f"   跳过 {len(skipped_empty_genes)} 个无试验数据基因的 LLM 分析")
    print(f"   共 {total_tasks} 个分析任务，{runtime_cfg['concurrency']} 并发执行 ...")
    print("   ", end="", flush=True)
    llm_results = llm_analyze_batch(llm_tasks, concurrency=runtime_cfg["concurrency"])
    print(f"   ✅ 全部完成（{len(llm_results)}/{total_tasks}）\n")

    # 提取结果
    llm_overview = llm_results.get("overview", "")
    llm_tracks: dict[str, str] = {}
    for track_id, _, _ in tracks:
        llm_tracks[track_id] = llm_results.get(f"track_{track_id}", "")
    llm_china = llm_results.get("china", "")
    llm_milestones = llm_results.get("milestones", "")

    # 组装基因专区
    gene_sections: list[str] = []
    for gene in genes:
        trials = gene_data.get(gene["id"], [])
        llm_gene = llm_results.get(f"gene_{gene['id']}", "")
        gene_sections.append(format_gene_section(gene, trials, llm_gene, translations))

    # Step 4: 组装报告
    print("📝 Step 4: 组装最终报告 ...")
    report = assemble_report(
        template_path=_TEMPLATE_PATH,
        month_label=month_label,
        issue_num=1,
        start_date=start_date,
        end_date=end_date,
        gene_count=len(genes),
        trial_count=len(all_trials),
        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M"),
        overall_stats_table=stats_table,
        llm_overview=llm_overview,
        gene_sections="\n\n".join(gene_sections),
        llm_ras=llm_tracks["ras"],
        llm_adc=llm_tracks["adc"],
        llm_immune=llm_tracks["immune"],
        llm_ddr=llm_tracks["ddr"],
        llm_protac=llm_tracks["protac"],
        llm_shp2=llm_tracks["shp2"],
        trial_list_all=format_trial_list_all(all_trials, translations),
        llm_china=llm_china,
        llm_milestones=llm_milestones,
        glossary=format_glossary(genes),
    )
    print("   ✅ 完成\n")

    # 写入文件
    _REPORT_DIR.mkdir(parents=True, exist_ok=True)
    month_tag = datetime.now().strftime("%Y-%m")
    output_path = _REPORT_DIR / f"NCCN_月报_{month_tag}.md"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"📄 月报已生成: {output_path}")
    print(f"   字数: ~{len(report)} 字符")
    return report


def assemble_report(**kwargs) -> str:
    """读取模板并填充占位符。"""
    with open(kwargs["template_path"], encoding="utf-8") as f:
        template = f.read()

    for key, value in kwargs.items():
        if key == "template_path":
            continue
        placeholder = "{" + key + "}"
        template = template.replace(placeholder, str(value))

    return template


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------
async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="NCCN 胰腺癌临床试验月报生成器")
    parser.add_argument("--gene", "-g", default=None, help="仅生成指定基因的报告（基因ID）")
    parser.add_argument("--no-llm", action="store_true", help="跳过 LLM 分析，输出骨架")
    parser.add_argument("--no-cache", action="store_true", help="忽略缓存，重新搜索")
    parser.add_argument("--translate", action="store_true", help="启用试验标题翻译（默认关闭，LLM分析已为中文）")
    parser.add_argument("--llm-concurrency", type=int, default=None, help="覆盖 LLM 并发数（1-8）")
    args = parser.parse_args()

    await generate_report(
        gene_filter=args.gene,
        use_llm=not args.no_llm,
        translate=args.translate,
        use_cache=not args.no_cache,
        llm_concurrency=args.llm_concurrency,
    )


if __name__ == "__main__":
    asyncio.run(main())
