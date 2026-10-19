"""
telegram - Telegram 消息推送渠道

从原 daily_ctgov_check_tgbot.py 抽取。
支持长消息分批(优先在换行处切分),单条上限 MAX_MSG_LEN=4000。

环境变量:
    TELEGRAM_BOT_TOKEN  Telegram Bot Token
    TELEGRAM_CHAT_ID    目标 chat id
"""

import os

import requests
import urllib3
from dotenv import load_dotenv

from lib.text_utils import split_text_by_len

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
MAX_TG_MSG_LEN = 4000


def _enabled_check():
    """检查 Telegram 推送前置条件"""
    if not (TG_TOKEN and TG_CHAT_ID):
        print("⚠️  缺少 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID,跳过 Telegram 推送")
        return False
    return True


def send_msg(text):
    """
    发送消息到 Telegram。超长消息自动分批(优先在换行处切分),每批加 (续 i/n) 尾标。
    """
    if not _enabled_check():
        return
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    parts = split_text_by_len(text, MAX_TG_MSG_LEN)
    for part in parts:
        try:
            requests.post(url, json={"chat_id": TG_CHAT_ID, "text": part}, timeout=15, verify=False)
        except Exception as e:
            print(f"Error sending Telegram message: {e}")


def send_batch(messages):
    """批量发送多条消息"""
    if not _enabled_check():
        return 0
    ok = 0
    for msg in messages:
        try:
            send_msg(msg)
            ok += 1
        except Exception as e:
            print(f"⚠️  TG 发送失败: {e}")
    return ok
