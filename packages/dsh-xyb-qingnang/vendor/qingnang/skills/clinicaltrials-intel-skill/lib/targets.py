"""
targets - 胰腺癌靶点 YAML 加载与关键词展开

可复用配置文件：
    assets/pancreatic_targets.yaml

其它项目复用方式：
    1) 复制 assets/pancreatic_targets.yaml
    2) 或软链接到本文件
    3) from lib.targets import expand_keywords, load_targets_config

优先级（本项目抓取默认关键词）：
    环境变量 KEYWORDS（非空） > YAML default_groups 展开 > 内置 fallback
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

import yaml

from lib.text_utils import parse_list_config

_TARGETS_PATH = Path(__file__).resolve().parent.parent / "assets" / "pancreatic_targets.yaml"

# 与历史 .env 兼容的最小 fallback（YAML 缺失时使用）
_FALLBACK_KEYWORDS = [
    "KRAS", "Immune", "Immunotherapy", "TP53", "ATM", "免疫", "免疫治疗", "BRCA",
    "EGFR", "MET", "C-MET", "c-Met", "HER2", "ERBB2", "TROP2", "TACSTD2",
    "CLDN18.2", "Claudin 18.2", "Claudin18.2", "TF", "Tissue Factor",
    "MSLN", "Mesothelin", "B7H3", "B7-H3", "CD276", "Nectin-4", "NECTIN4", "PVRL4",
    "NTRK", "pan-TRK", "CDH17", "CEACAM5", "CEA", "MTAP",
    "MUC1", "FOLR1", "Folate receptor", "DLL3", "CA125", "MUC16",
]


def load_targets_config(path: str | Path | None = None) -> dict[str, Any]:
    """加载 pancreatic_targets.yaml；文件缺失时返回空 dict。"""
    cfg_path = Path(path) if path else _TARGETS_PATH
    if not cfg_path.exists():
        return {}
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        print(f"⚠️  读取靶点 YAML 失败 ({cfg_path}): {e}")
        return {}


def list_targets(
    groups: Iterable[str] | None = None,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """按分组返回靶点列表。groups=None 时用 YAML 的 default_groups。"""
    cfg = config if config is not None else load_targets_config()
    targets = cfg.get("targets") or []
    if not targets:
        return []

    if groups is None:
        groups = cfg.get("default_groups") or ["core", "A", "B", "C"]
    group_set = {str(g) for g in groups}
    return [t for t in targets if str(t.get("group", "")) in group_set]


def expand_keywords(
    groups: Iterable[str] | None = None,
    config: dict[str, Any] | None = None,
    include_aliases: bool = False,
) -> list[str]:
    """
    展开检索关键词列表（保序去重）。

    - 默认取每个靶点的 keywords 字段；为空则回退 aliases
    - include_aliases=True 时额外并入 aliases
    """
    targets = list_targets(groups=groups, config=config)
    if not targets:
        return list(_FALLBACK_KEYWORDS)

    seen: set[str] = set()
    out: list[str] = []
    for t in targets:
        words: list[str] = []
        kws = t.get("keywords") or []
        aliases = t.get("aliases") or []
        if kws:
            words.extend(str(x).strip() for x in kws if str(x).strip())
        elif aliases:
            words.extend(str(x).strip() for x in aliases if str(x).strip())
        if include_aliases:
            words.extend(str(x).strip() for x in aliases if str(x).strip())

        for w in words:
            if w not in seen:
                seen.add(w)
                out.append(w)
    return out or list(_FALLBACK_KEYWORDS)


def resolve_default_keywords(
    env_keywords: str | None = None,
    groups: Iterable[str] | None = None,
) -> list[str]:
    """
    解析本项目默认 KEYWORDS：
      1. 若 env KEYWORDS 非空 → 解析逗号列表（显式覆盖）
      2. 否则从 YAML 展开
      3. YAML 失败 → fallback 列表
    """
    raw = env_keywords if env_keywords is not None else os.getenv("KEYWORDS")
    # 约定：KEYWORDS=yaml 或 KEYWORDS=@yaml 时强制走 YAML
    if raw is not None:
        s = str(raw).strip()
        if s and s.lower() not in {"yaml", "@yaml", "from_yaml", "auto"}:
            parsed = parse_list_config(s)
            if parsed:
                return parsed
    return expand_keywords(groups=groups)


# ---------------------------------------------------------------------------
# 单一靶点解析（菜单 / CLI 输入 → YAML 匹配 + 检索词展开）
# ---------------------------------------------------------------------------

def _norm_key(s: str) -> str:
    """大小写/分隔符无关的规范化键：去空白、连字符、下划线、点号。"""
    t = str(s or "").strip().lower()
    for ch in (" ", "-", "_", ".", "/", "（", "）", "(", ")"):
        t = t.replace(ch, "")
    return t


def _target_match_keys(target: dict[str, Any]) -> list[str]:
    """收集一个靶点可用于匹配的全部键（id/name/aliases/keywords/cn_name）。"""
    keys: list[str] = []
    for field in ("id", "name", "cn_name"):
        v = target.get(field)
        if v:
            keys.append(str(v))
    for field in ("aliases", "keywords"):
        for item in target.get(field) or []:
            if item:
                keys.append(str(item))
    return keys


def target_keywords(target: dict[str, Any], include_aliases: bool = True) -> list[str]:
    """从单个靶点展开检索词（保序去重）。"""
    seen: set[str] = set()
    out: list[str] = []
    words: list[str] = []
    kws = target.get("keywords") or []
    aliases = target.get("aliases") or []
    if kws:
        words.extend(str(x).strip() for x in kws if str(x).strip())
    if include_aliases or not kws:
        words.extend(str(x).strip() for x in aliases if str(x).strip())
    if not words and target.get("name"):
        words.append(str(target["name"]).strip())
    for w in words:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out


def match_target(
    query: str,
    config: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """
    将用户输入与 YAML 靶点做泛化匹配。

    匹配顺序（命中即返回）:
      1. 规范化后精确匹配 id / name / aliases / keywords / cn_name
      2. 双向包含（如 b7h3 ↔ B7-H3 (CD276)、claudin18.2 ↔ CLDN18.2）

    返回匹配到的靶点 dict；未命中返回 None。
    """
    q = (query or "").strip()
    if not q:
        return None

    cfg = config if config is not None else load_targets_config()
    targets = cfg.get("targets") or []
    if not targets:
        return None

    nq = _norm_key(q)
    if not nq:
        return None

    # 1) 精确匹配
    for t in targets:
        for key in _target_match_keys(t):
            if _norm_key(key) == nq:
                return t

    # 2) 包含匹配（避免过短误伤：query 至少 3 字符，或候选键较短时允许）
    candidates: list[tuple[int, dict[str, Any]]] = []
    for t in targets:
        for key in _target_match_keys(t):
            nk = _norm_key(key)
            if not nk:
                continue
            if nq in nk or nk in nq:
                # 过短串（如 tf/met）只允许精确，已在步骤1处理
                if min(len(nq), len(nk)) < 3 and nq != nk:
                    continue
                # 评分：更短的“差异”优先（更像同一个靶点）
                score = abs(len(nq) - len(nk))
                candidates.append((score, t))
                break

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def resolve_target_query(
    query: str,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    解析用户输入的单一靶点，返回统一结构：

        {
          "query": 原始输入,
          "matched": True/False,
          "target": 靶点 dict 或 None,
          "display_name": 展示名,
          "keywords": 检索词列表（命中 YAML 则用其 keywords+aliases；否则 [query]）,
        }
    """
    q = (query or "").strip()
    target = match_target(q, config=config) if q else None
    if target:
        kws = target_keywords(target, include_aliases=True)
        display = target.get("name") or target.get("id") or q
        return {
            "query": q,
            "matched": True,
            "target": target,
            "display_name": display,
            "keywords": kws,
        }
    # 未命中 YAML：仍允许按用户原文检索（不阻断）
    return {
        "query": q,
        "matched": False,
        "target": None,
        "display_name": q or "unknown",
        "keywords": [q] if q else [],
    }


def format_targets_catalog(config: dict[str, Any] | None = None) -> str:
    """生成菜单提示用的靶点清单（按分组）。"""
    cfg = config if config is not None else load_targets_config()
    targets = cfg.get("targets") or []
    group_meta = cfg.get("groups") or {}
    order = cfg.get("default_groups") or ["core", "A", "B", "C"]

    by_group: dict[str, list[dict[str, Any]]] = {}
    for t in targets:
        g = str(t.get("group", "other"))
        by_group.setdefault(g, []).append(t)

    lines: list[str] = []
    for g in order:
        items = by_group.get(g) or []
        if not items:
            continue
        gname = (group_meta.get(g) or {}).get("name") or g
        lines.append(f"  [{g}] {gname}")
        for t in items:
            name = t.get("name") or t.get("id")
            aliases = t.get("aliases") or []
            alias_hint = ""
            if aliases:
                # 只展示与 name 不同的前 2 个别名，避免刷屏
                extras = [a for a in aliases if str(a).lower() != str(name).lower()][:2]
                if extras:
                    alias_hint = f"  (别名: {', '.join(str(a) for a in extras)})"
            lines.append(f"    - {name}{alias_hint}")
    return "\n".join(lines) if lines else "  (未加载到靶点 YAML)"
