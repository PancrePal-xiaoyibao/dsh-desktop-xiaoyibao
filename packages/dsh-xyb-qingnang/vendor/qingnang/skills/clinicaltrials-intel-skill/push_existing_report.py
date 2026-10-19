#!/usr/bin/env python3
"""
单独推送已有报告内容
支持从指定的 telegram_push_report.txt 文件读取内容并推送到各渠道

用法示例:
    # 推送到微信文字
    python3 push_existing_report.py --file output/2026-06-17-Pancreatic_Cancer/telegram_push_report.txt --send-gewe-txt
    
    # 推送到多个渠道
    python3 push_existing_report.py --file output/2026-06-17-Pancreatic_Cancer/telegram_push_report.txt --channels tg,gewe_txt,feishu
    
    # 推送最新的报告到所有渠道
    python3 push_existing_report.py --latest --all-channels
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def find_latest_report(base_dir="output"):
    """
    在 output 目录下查找最新的 telegram_push_report.txt 文件
    返回文件路径,如果未找到返回 None
    """
    output_path = Path(base_dir)
    if not output_path.exists():
        return None
    
    report_files = list(output_path.glob("*/telegram_push_report.txt"))
    if not report_files:
        return None
    
    # 按修改时间排序,返回最新的
    report_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return report_files[0]


def parse_report_content(file_path):
    """
    解析 telegram_push_report.txt 文件,按分隔符切分成多个部分
    返回: (汇总部分, [详情部分列表], 结尾部分)
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 按分隔符切分
        separator = "=" * 50
        parts = content.split(f"\n{separator}\n")
        
        if len(parts) < 2:
            # 没有分隔符,整个内容作为一条消息
            return content, [], ""
        
        # 第一部分是汇总(包含标题、清单等)
        summary = parts[0].strip()
        
        # 中间部分是详情
        detail_groups = []
        footer = ""
        
        for i, part in enumerate(parts[1:], 1):
            part = part.strip()
            if not part:
                continue
            # 最后一部分如果是社区公益脚注则为 footer
            # 兼容胰腺癌「以上由小胰宝...」和通用「以上由小x宝...」两种文案
            if "以上由小" in part or "社区志愿者" in part:
                footer = part
            else:
                detail_groups.append(part)
        
        return summary, detail_groups, footer
    except Exception as e:
        print(f"❌ 解析报告文件失败: {e}")
        return None, [], ""


def push_to_telegram(summary, detail_groups, footer):
    """推送到 Telegram"""
    from lib.channels.telegram import send_msg
    print(f"\n📤 推送到 Telegram...")
    try:
        if summary:
            send_msg(summary)
        for i, detail in enumerate(detail_groups, 1):
            print(f"   发送详情 {i}/{len(detail_groups)}")
            send_msg(detail)
        if footer:
            send_msg(footer)
        print(f"   ✅ Telegram 推送完成")
        return True
    except Exception as e:
        print(f"   ❌ Telegram 推送失败: {e}")
        return False


def push_to_gewe_txt(summary, detail_groups, footer):
    """推送到 GeWe 文字"""
    from lib.channels.gewe import send_text
    print(f"\n📤 推送到 GeWe 文字...")
    try:
        if summary:
            send_text(summary)
        for i, detail in enumerate(detail_groups, 1):
            print(f"   发送详情 {i}/{len(detail_groups)}")
            send_text(detail)
        if footer:
            send_text(footer)
        print(f"   ✅ GeWe 文字推送完成")
        return True
    except Exception as e:
        print(f"   ❌ GeWe 文字推送失败: {e}")
        return False


def push_to_feishu(summary, detail_groups, footer):
    """推送到飞书(使用文本消息)"""
    print(f"\n📤 推送到飞书...")
    try:
        from lib.channels.feishu import get_access_token, _enabled_check
        import os
        import requests
        
        if not _enabled_check():
            print(f"   ⚠️  飞书推送未启用或配置不完整")
            return False
        
        # 获取 access token
        token = get_access_token()
        if not token:
            print(f"   ❌ 获取 access token 失败")
            return False
        
        # 组合完整内容
        full_content = summary
        if detail_groups:
            full_content += "\n\n" + "\n\n".join(detail_groups)
        if footer:
            full_content += "\n\n" + footer
        
        # 获取群 ID 列表
        from lib.text_utils import parse_list_config
        chat_ids_str = os.getenv("FEISHU_CHAT_IDS", "").strip()
        chat_ids = parse_list_config(chat_ids_str)
        
        if not chat_ids:
            print(f"   ⚠️  未配置 FEISHU_CHAT_IDS")
            return False
        
        # 推送到每个群
        success_count = 0
        for chat_id in chat_ids:
            url = "https://open.feishu.cn/open-apis/im/v1/messages"
            params = {"receive_id_type": "chat_id"}
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8"
            }
            body = {
                "receive_id": chat_id,
                "msg_type": "text",
                "content": '{"text":"' + full_content.replace('"', '\\"').replace('\n', '\\n') + '"}'
            }
            
            resp = requests.post(url, params=params, headers=headers, json=body, timeout=15)
            if resp.status_code == 200 and resp.json().get("code") == 0:
                success_count += 1
                print(f"   ✅ 飞书群 {chat_id} 推送成功")
            else:
                print(f"   ⚠️  飞书群 {chat_id} 推送失败: {resp.text[:100]}")
        
        print(f"   ✅ 飞书推送完成: {success_count}/{len(chat_ids)} 个群成功")
        return success_count > 0
    except Exception as e:
        print(f"   ❌ 飞书推送失败: {e}")
        return False


def dispatch_push(channel, summary, detail_groups, footer):
    """分发到指定渠道"""
    if channel == "tg":
        return push_to_telegram(summary, detail_groups, footer)
    elif channel == "gewe_txt":
        return push_to_gewe_txt(summary, detail_groups, footer)
    elif channel == "feishu":
        return push_to_feishu(summary, detail_groups, footer)
    elif channel == "gewe_card":
        print(f"   ⚠️  gewe_card 渠道需要完整的 study 数据结构,不支持从文本推送")
        return False
    elif channel == "fastgpt":
        print(f"   ⚠️  fastgpt 渠道需要完整的 Markdown 文件和 JSON 数据,不支持从文本推送")
        return False
    else:
        print(f"   ⚠️  未知渠道: {channel}")
        return False


def resolve_channels(args):
    """解析要推送的渠道列表"""
    from lib.config import ALL_CHANNELS
    
    channels = set()
    
    # 显式指定的渠道
    if args.send_tg:
        channels.add("tg")
    if args.send_gewe_txt:
        channels.add("gewe_txt")
    if args.send_gewe_card:
        channels.add("gewe_card")
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
        # 只添加支持文本推送的渠道
        channels.update(["tg", "gewe_txt", "feishu"])
    
    # --no-channels 排除
    if args.no_channels:
        for ch in args.no_channels.split(","):
            channels.discard(ch.strip())
    
    return sorted(channels)


def main():
    parser = argparse.ArgumentParser(
        description="单独推送已有报告内容到各渠道",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  %(prog)s --file output/2026-06-17-Pancreatic_Cancer/telegram_push_report.txt --send-gewe-txt
  %(prog)s --latest --channels tg,gewe_txt,feishu
  %(prog)s --file report.txt --all-channels
""")
    
    # 文件选择
    file_group = parser.add_mutually_exclusive_group(required=True)
    file_group.add_argument("--file", type=str,
                           help="指定要推送的报告文件路径")
    file_group.add_argument("--latest", action="store_true",
                           help="自动查找并推送最新的报告文件")
    
    # 推送渠道
    push_group = parser.add_argument_group("推送渠道")
    push_group.add_argument("--send-tg", action="store_true", help="推送到 Telegram")
    push_group.add_argument("--send-gewe-txt", action="store_true", help="推送到 GeWe 文字")
    push_group.add_argument("--send-gewe-card", action="store_true", help="推送到 GeWe 卡片(不支持)")
    push_group.add_argument("--send-feishu", action="store_true", help="推送到飞书")
    push_group.add_argument("--send-fastgpt", action="store_true", help="推送到 FastGPT(不支持)")
    
    # 多渠道简写
    short_group = parser.add_argument_group("多渠道简写")
    short_group.add_argument("--channels", type=str,
                            help="逗号分隔的多渠道,如 tg,gewe_txt,feishu")
    short_group.add_argument("--all-channels", action="store_true",
                            help="推送到所有支持的渠道(tg,gewe_txt,feishu)")
    short_group.add_argument("--no-channels", type=str,
                            help="排除的渠道(逗号分隔)")
    
    args = parser.parse_args()
    
    # 确定报告文件路径
    if args.latest:
        file_path = find_latest_report()
        if not file_path:
            print("❌ 未找到任何报告文件")
            return 1
        print(f"📄 找到最新报告: {file_path}")
    else:
        file_path = Path(args.file)
        if not file_path.exists():
            print(f"❌ 文件不存在: {file_path}")
            return 1
    
    # 解析报告内容
    print(f"📖 解析报告内容...")
    summary, detail_groups, footer = parse_report_content(file_path)
    if summary is None:
        return 1
    
    print(f"   汇总部分: {len(summary)} 字符")
    print(f"   详情分组: {len(detail_groups)} 组")
    print(f"   结尾部分: {len(footer)} 字符")
    
    # 确定推送渠道
    channels = resolve_channels(args)
    if not channels:
        print("❌ 未指定推送渠道,请使用 --send-* / --channels / --all-channels")
        return 1
    
    print(f"\n📤 开始推送到 {len(channels)} 个渠道: {', '.join(channels)}")
    print("="*60)
    
    # 执行推送
    success_count = 0
    for ch in channels:
        if dispatch_push(ch, summary, detail_groups, footer):
            success_count += 1
    
    # 总结
    print("\n" + "="*60)
    print(f"✅ 推送完成: {success_count}/{len(channels)} 个渠道成功")
    print("="*60)
    
    return 0 if success_count == len(channels) else 1


if __name__ == "__main__":
    sys.exit(main())
