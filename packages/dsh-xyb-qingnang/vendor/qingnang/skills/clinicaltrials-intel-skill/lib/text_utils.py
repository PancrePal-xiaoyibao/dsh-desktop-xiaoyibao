"""
text_utils - 文本处理工具

纯函数,零外部依赖(仅标准库),可被任意模块复用。
包含:
- sanitize_filename: 文件名清洗(去除非法字符)
- markdown_to_plain: Markdown 转纯文本(适配公众号等不支持 MD 的渠道)
- split_text_by_len: 按长度分批(优先在换行处切分)
- parse_list_config: 解析列表配置(兼容 JSON 数组 / 逗号分隔 / 单值三种写法)
"""

import json
import re


def sanitize_filename(filename):
    """清洗文件名:仅保留字母数字、空格、._-"""
    return "".join([c for c in filename if c.isalnum() or c in (' ', '.', '_', '-')]).strip().replace(' ', '_')


def markdown_to_plain(text):
    """
    将 Markdown 文本转换为公众号友好的纯文本。
    保留 emoji 和换行,去除 # 标题 / **加粗** / [链接](url) 等语法。

    转换规则:
        [文本](url) → 文本(url)
        **加粗** / __加粗__ → 去掉包裹符
        行首 # 标题 → 去掉标记(保留标题文字)
        行首 - / * 列表 → 转为 •
        `代码` → 去掉反引号
    """
    if not text:
        return text
    # [文本](url) → 文本(url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1(\2)', text)
    # **加粗** 和 __加粗__ → 去掉包裹符
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    # 行首的 # 标题标记 → 去掉(保留标题文字本身)
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    # 行首的 - / * 列表标记 → 转为 •
    text = re.sub(r'^[\s]*[-*]\s+', '• ', text, flags=re.MULTILINE)
    # 去掉 `代码` 的反引号
    text = re.sub(r'`([^`]+)`', r'\1', text)
    return text


def split_text_by_len(text, max_len):
    """
    按长度分批,优先在换行处切分。
    返回分批后的列表;多批时自动追加 (续 i/n) 尾标,空文本返回空列表。
    """
    if not text or len(text) <= max_len:
        return [text] if text else []

    parts = []
    temp_text = text
    while len(temp_text) > 0:
        if len(temp_text) <= max_len:
            parts.append(temp_text)
            break
        # 优先在换行处切分,找不到则硬切
        split_idx = temp_text.rfind('\n', 0, max_len)
        if split_idx == -1 or split_idx == 0:
            split_idx = max_len
        parts.append(temp_text[:split_idx])
        temp_text = temp_text[split_idx:].lstrip()

    # 多批时追加尾标
    if len(parts) > 1:
        total = len(parts)
        parts = [f"{p}\n(续 {i+1}/{total})" for i, p in enumerate(parts)]
    return parts


def parse_list_config(raw):
    """
    解析列表配置,统一三种写法:
        1. JSON 数组:  '["a","b","c"]'
        2. 逗号分隔:  'a,b,c'
        3. 单值:      'a'

    返回去除空格和空项后的列表。空输入返回 []。
    用于解析 GEWE_TO_WXID / FASTGPT_LOCAL_DIR 等多值环境变量。
    """
    if not raw:
        return []
    s = raw.strip() if isinstance(raw, str) else str(raw).strip()
    if not s:
        return []
    # 优先尝试 JSON 数组解析
    if s.startswith("[") and s.endswith("]"):
        try:
            arr = json.loads(s)
            return [str(w).strip() for w in arr if str(w).strip()]
        except Exception:
            pass  # 解析失败则回退到逗号分隔
    # 逗号分隔(含单值)
    return [w.strip() for w in s.split(",") if w.strip()]
