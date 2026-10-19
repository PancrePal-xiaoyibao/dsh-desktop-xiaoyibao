#!/usr/bin/env python3
"""
通用双语翻译模块。

提供 translate_fields() 函数，输入任意字典列表 + 指定字段，
使用配置的 LLM 分批并发翻译为中文，输出翻译结果。

用法:
    from translator import translate_fields

    translations = translate_fields(
        items=trials,
        fields=["title", "conditions", "interventions"],
        key_field="nct_id",
        domain="临床试验",
    )
    # translations = {"NCT12345": {"title": "中文...", ...}, ...}
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

# 添加脚本目录到路径，以便导入 config_loader
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

# 自动加载 .env 文件（如存在）
_SKILL_ROOT = _SCRIPT_DIR.parent


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

from config_loader import get_llm_config  # noqa: E402

# LLM 调用超时（秒）
_LLM_TIMEOUT = 60
# 最大重试次数
_MAX_RETRIES = 2
# 重试间隔（秒）
_RETRY_DELAY = 2
# 默认分批大小
_DEFAULT_BATCH_SIZE = 8
# 翻译并发数
_CONCURRENCY = 2


def translate_fields(
    items: list[dict[str, Any]],
    fields: list[str],
    key_field: str = "id",
    domain: str = "医学",
    config: dict[str, Any] | None = None,
    use_llm: bool = True,
    batch_size: int = _DEFAULT_BATCH_SIZE,
) -> dict[str, dict[str, str]]:
    """
    通用双语翻译：输入任意字典列表 + 指定字段，输出翻译结果。

    使用配置的 LLM 分批并发翻译（默认每批 8 条，2 并发），
    兼顾速度与 API 响应稳定性。

    Parameters
    ----------
    items : list[dict]
        待翻译的字典列表，每个字典包含 key_field 和 fields 指定的字段。
    fields : list[str]
        需要翻译的字段名列表，如 ["title", "conditions"]。
    key_field : str
        用作返回索引的字段名，如 "nct_id"、"drug_id"。
    domain : str
        领域上下文，帮助 LLM 生成更精准的翻译（如"临床试验"、"药品说明书"）。
    config : dict | None
        genes.yaml 配置字典，为 None 时自动加载。
    use_llm : bool
        是否调用 LLM，为 False 时直接返回空字典。
    batch_size : int
        每批翻译的条目数（默认 8，兼顾 payload 大小和 API 响应速度）。

    Returns
    -------
    dict[str, dict[str, str]]
        以 key_field 值为 key，值为 {field: translated_text, ...}。
        字段名与输入 fields 一致，不带 _cn 后缀。

    Examples
    --------
    >>> translations = translate_fields(
    ...     items=trials,
    ...     fields=["title", "conditions"],
    ...     key_field="nct_id",
    ...     domain="临床试验",
    ... )
    >>> translations["NCT12345"]["title"]
    'KRAS G12D抑制剂治疗胰腺癌'
    """
    if not use_llm or not items:
        return {}

    llm_cfg = get_llm_config(config)
    if not llm_cfg["api_key"]:
        return {}

    try:
        from openai import OpenAI
    except ImportError:
        return {}

    # 创建带超时的 client
    client = OpenAI(
        api_key=llm_cfg["api_key"],
        base_url=llm_cfg["base_url"] or None,
        timeout=_LLM_TIMEOUT,
    )

    # 分批
    batches: list[list[dict[str, str]]] = []
    for i in range(0, len(items), batch_size):
        batch = []
        for item in items[i:i + batch_size]:
            entry: dict[str, str] = {key_field: str(item.get(key_field, ""))}
            for f in fields:
                val = item.get(f, "")
                entry[f] = str(val) if val else ""
            batch.append(entry)
        batches.append(batch)

    total_batches = len(batches)
    print(f"   共 {len(items)} 条，分 {total_batches} 批，{_CONCURRENCY} 并发翻译 ...", flush=True)

    # 并发执行各批翻译
    result: dict[str, dict[str, str]] = {}
    with ThreadPoolExecutor(max_workers=_CONCURRENCY) as executor:
        future_map = {}
        for batch_idx, batch in enumerate(batches):
            prompt = _build_prompt(batch, fields, key_field, domain)
            future = executor.submit(
                _call_translate_llm, client, llm_cfg, prompt, key_field, fields
            )
            future_map[future] = batch_idx

        for future in as_completed(future_map):
            batch_idx = future_map[future]
            try:
                partial = future.result()
                if partial:
                    result.update(partial)
                    print(f"✅(batch{batch_idx}+{len(partial)})", end=" ", flush=True)
                else:
                    print(f"⚠️(batch{batch_idx}空)", end=" ", flush=True)
            except Exception as exc:
                print(f"❌(batch{batch_idx}:{str(exc)[:30]})", end=" ", flush=True)

    print(f"\n   ✅ 已翻译 {len(result)}/{len(items)} 条", flush=True)
    return result


def _build_prompt(
    batch: list[dict[str, str]],
    fields: list[str],
    key_field: str,
    domain: str,
) -> str:
    """构造 LLM 翻译 prompt。"""
    fields_desc = "、".join(fields)
    prompt = (
        f"请将以下{domain}信息中的 {fields_desc} 字段翻译为中文"
        "（医学专业术语保持英文缩写，如KRAS、PARP、ADC等不翻译）。\n"
        f"严格按 JSON 数组格式返回，每项包含 {key_field} 和翻译后的字段"
        f"（字段名保持不变：{', '.join(fields)}）。\n"
        f"示例格式：\n"
        f'[{{"{key_field}":"SAMPLE","{fields[0]}":"翻译内容"'
    )
    if len(fields) > 1:
        prompt += f',"{fields[1]}":"翻译内容"'
    prompt += "}]\n\n"
    prompt += f"待翻译数据（共{len(batch)}条）：\n"
    prompt += json.dumps(batch, ensure_ascii=False, indent=2)
    return prompt


def _call_translate_llm(
    client: Any,
    llm_cfg: dict[str, Any],
    prompt: str,
    key_field: str,
    fields: list[str],
) -> dict[str, dict[str, str]]:
    """调用 LLM 执行翻译，带重试。失败返回空字典。"""
    for attempt in range(1, _MAX_RETRIES + 2):
        try:
            resp = client.chat.completions.create(
                model=llm_cfg["model"],
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "你是翻译专家，擅长中英互译。"
                            "严格返回JSON数组，不要添加任何其他文字。"
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=min(llm_cfg.get("max_tokens", 20000), 8000),
            )
            content = resp.choices[0].message.content.strip()
            return _parse_translate_response(content, key_field, fields)
        except Exception as exc:
            err_msg = str(exc)
            if attempt <= _MAX_RETRIES:
                time.sleep(_RETRY_DELAY * attempt)
            else:
                return {}
    return {}


def _parse_translate_response(
    content: str,
    key_field: str,
    fields: list[str],
) -> dict[str, dict[str, str]]:
    """解析 LLM 返回的翻译 JSON。"""
    # 提取 JSON（可能被 markdown code block 包裹）
    if "```" in content:
        json_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
        if json_match:
            content = json_match.group(1).strip()

    # 尝试找到 JSON 数组的起止位置
    start_idx = content.find("[")
    end_idx = content.rfind("]")
    if start_idx == -1 or end_idx == -1:
        return {}

    json_str = content[start_idx:end_idx + 1]
    try:
        translated = json.loads(json_str)
    except json.JSONDecodeError:
        return {}

    if not isinstance(translated, list):
        return {}

    result: dict[str, dict[str, str]] = {}
    for item in translated:
        key_val = str(item.get(key_field, ""))
        if key_val:
            result[key_val] = {
                f: str(item.get(f, "")) for f in fields
            }
    return result