"""
config - 渠道与流程配置读取

从 config.yaml 读取渠道默认开关和流程行为。
CLI 参数(--send-xxx / --no-channels / --all-channels)可覆盖默认值。

优先级:
    CLI 显式参数 > config.yaml 默认值
"""

import os
from pathlib import Path

import yaml

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"

# 渠道全集
ALL_CHANNELS = ["tg", "gewe_txt", "gewe_card", "feishu", "fastgpt"]


def load_config():
    """加载 config.yaml,返回完整配置 dict。文件缺失时返回安全默认值。"""
    defaults = {
        "channels": {
            "tg": True,
            "gewe_txt": True,
            "gewe_card": False,
            "feishu": True,
            "fastgpt": True,
        },
        "workflow": {
            "auto_save_json": True,
            "fastgpt_translate_first": True,
            "gewe_txt_max_len": 2000,
        }
    }
    if not _CONFIG_PATH.exists():
        return defaults
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            loaded = yaml.safe_load(f) or {}
        # 合并:loaded 覆盖 defaults(仅顶层 dict 浅合并 channels/workflow)
        for section in ("channels", "workflow"):
            if section in loaded and isinstance(loaded[section], dict):
                defaults[section].update(loaded[section])
        return defaults
    except Exception as e:
        print(f"⚠️  读取 config.yaml 失败,使用默认值: {e}")
        return defaults


def get_default_channels():
    """返回默认开启的渠道列表(从 config.yaml 读)"""
    cfg = load_config()
    return sorted([ch for ch, on in cfg["channels"].items() if on])


def get_workflow_setting(key, fallback=None):
    """读取 workflow 段的某个设置"""
    cfg = load_config()
    return cfg["workflow"].get(key, fallback)


def resolve_channels_from_args(args):
    """
    合并 CLI 参数与 config.yaml 默认值,返回最终渠道列表。

    优先级:
        --send-xxx / --channels / --all-channels 显式参数 > config.yaml 默认
        --no-channels 排除总是生效
    """
    cfg = load_config()
    channels = set()

    # 1. 如果有任何显式 --send-* / --channels / --all-channels,以 CLI 为准
    has_explicit = (args.send_tg or args.send_gewe_card or args.send_gewe_txt
                    or args.send_feishu or args.send_fastgpt
                    or args.channels or args.all_channels)

    if has_explicit:
        # 显式开关
        if args.send_tg:
            channels.add("tg")
        if args.send_gewe_card:
            channels.add("gewe_card")
        if args.send_gewe_txt:
            channels.add("gewe_txt")
        if args.send_feishu:
            channels.add("feishu")
        if args.send_fastgpt:
            channels.add("fastgpt")
        # --channels 简写
        if args.channels:
            for ch in args.channels.split(","):
                ch = ch.strip()
                if ch:
                    channels.add(ch)
        # --all-channels
        if args.all_channels:
            channels.update(ALL_CHANNELS)
    else:
        # 无显式参数 → 用 config.yaml 默认值
        channels.update(get_default_channels())

    # 2. --no-channels 排除(总是生效)
    if args.no_channels:
        for ch in args.no_channels.split(","):
            channels.discard(ch.strip())

    return sorted(channels)
