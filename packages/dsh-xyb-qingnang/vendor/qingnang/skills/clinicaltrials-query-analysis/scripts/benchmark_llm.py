#!/usr/bin/env python3
"""Benchmark configured OpenAI-compatible LLM providers.

The script sends a tiny prompt to each configured provider and reports
time-to-first-token and total latency. It never prints API keys.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))
_SKILL_ROOT = _SCRIPT_DIR.parent

from config_loader import load_config  # noqa: E402


def _load_dotenv() -> None:
    env_path = _SKILL_ROOT / ".env"
    if not env_path.exists():
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _provider_config(name: str, config: dict[str, Any]) -> dict[str, Any] | None:
    llm_cfg = config.get("llm", {})
    provider_cfg = llm_cfg.get("providers", {}).get(name)
    if not provider_cfg:
        return None

    api_key = os.environ.get(provider_cfg.get("api_key_env", ""), "")
    if not api_key:
        return None

    base_url_env = provider_cfg.get("base_url_env", "")
    base_url = os.environ.get(base_url_env, "") if base_url_env else ""
    if not base_url:
        base_url = provider_cfg.get("base_url_default", "") or provider_cfg.get("base_url", "")

    model = os.environ.get(
        provider_cfg.get("model_env", ""),
        provider_cfg.get("model_default", ""),
    )

    return {
        "provider": name,
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
    }


def _configured_providers(config: dict[str, Any], all_configured: bool) -> list[dict[str, Any]]:
    llm_cfg = config.get("llm", {})
    if all_configured:
        order = list(llm_cfg.get("providers", {}).keys())
    else:
        order = llm_cfg.get("fallback", []) or [llm_cfg.get("provider", "custom")]

    providers = []
    seen = set()
    for name in order:
        if not name or name in seen:
            continue
        seen.add(name)
        provider = _provider_config(name, config)
        if provider:
            providers.append(provider)
    return providers


def benchmark_provider(provider: dict[str, Any], timeout: float) -> dict[str, Any]:
    try:
        from openai import OpenAI
    except ImportError:
        return {"provider": provider["provider"], "ok": False, "error": "openai not installed"}

    client = OpenAI(
        api_key=provider["api_key"],
        base_url=provider["base_url"] or None,
        timeout=timeout,
    )

    messages = [
        {"role": "system", "content": "你是一个响应速度测试助手，只输出一句中文。"},
        {"role": "user", "content": "请用不超过20个字回答：胰腺癌临床试验月报测速。"},
    ]

    started = time.perf_counter()
    first_token_at: float | None = None
    text_parts: list[str] = []
    try:
        stream = client.chat.completions.create(
            model=provider["model"],
            messages=messages,
            temperature=0,
            max_tokens=64,
            stream=True,
        )
        for chunk in stream:
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta.content or ""
            if delta and first_token_at is None:
                first_token_at = time.perf_counter()
            if delta:
                text_parts.append(delta)
        finished = time.perf_counter()
    except Exception as exc:
        nonstream_result = benchmark_provider_nonstream(provider, client, messages)
        if nonstream_result.get("ok"):
            nonstream_result["stream_error"] = str(exc)[:80]
            return nonstream_result
        return {
            "provider": provider["provider"],
            "model": provider["model"],
            "ok": False,
            "error": str(exc)[:160],
        }

    text = "".join(text_parts).strip()
    if not text:
        nonstream_result = benchmark_provider_nonstream(provider, client, messages)
        if nonstream_result.get("ok") and nonstream_result.get("chars", 0) > 0:
            nonstream_result["stream_error"] = "empty stream content"
            return nonstream_result
        if nonstream_result.get("ok"):
            return {
                "provider": provider["provider"],
                "model": provider["model"],
                "ok": False,
                "error": "empty response",
            }

    return {
        "provider": provider["provider"],
        "model": provider["model"],
        "ok": True,
        "ttft": None if first_token_at is None else first_token_at - started,
        "total": finished - started,
        "chars": len(text),
        "sample": text[:40],
    }


def benchmark_provider_nonstream(
    provider: dict[str, Any],
    client: Any,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        resp = client.chat.completions.create(
            model=provider["model"],
            messages=messages,
            temperature=0,
            max_tokens=64,
        )
        finished = time.perf_counter()
        content = resp.choices[0].message.content or ""
    except Exception as exc:
        return {
            "provider": provider["provider"],
            "model": provider["model"],
            "ok": False,
            "error": str(exc)[:160],
        }

    text = content.strip()
    if not text:
        return {
            "provider": provider["provider"],
            "model": provider["model"],
            "ok": False,
            "error": "empty response",
        }

    return {
        "provider": provider["provider"],
        "model": provider["model"],
        "ok": True,
        "ttft": None,
        "total": finished - started,
        "chars": len(text),
        "sample": text[:40],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark configured LLM providers")
    parser.add_argument("--all-configured", action="store_true", help="test every provider with an API key")
    parser.add_argument("--timeout", type=float, default=30.0, help="per-provider timeout seconds")
    args = parser.parse_args()

    _load_dotenv()
    config = load_config()
    providers = _configured_providers(config, all_configured=args.all_configured)
    if not providers:
        print("No configured LLM providers found.")
        return 1

    print("| provider | model | ok | ttft_s | total_s | chars | note |")
    print("|---|---|---:|---:|---:|---:|---|")
    for provider in providers:
        result = benchmark_provider(provider, timeout=args.timeout)
        if result.get("ok"):
            ttft = result["ttft"]
            ttft_text = "" if ttft is None else f"{ttft:.2f}"
            print(
                f"| {result['provider']} | {result['model']} | yes | "
                f"{ttft_text} | {result['total']:.2f} | {result['chars']} | {result['sample']} |"
            )
        else:
            print(
                f"| {result['provider']} | {result.get('model', '')} | no |  |  | 0 | "
                f"{result.get('error', '')} |"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
