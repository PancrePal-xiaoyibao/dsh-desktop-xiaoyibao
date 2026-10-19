"""
fastgpt - FastGPT 知识库同步渠道(薄封装)

不重复实现同步逻辑,而是调用现有的 fastgpt_sync.py(argparse 脚本)。
这样:
- fastgpt_sync.py 完全不动(已是成熟实现,有 hash 去重、重试、状态库)
- 本模块只提供编程式调用入口,供 CLI 统一调度

环境变量:由 fastgpt_sync.py 自行读取,本模块不重复定义。
"""

import subprocess
import sys
from pathlib import Path

# fastgpt_sync.py 的绝对路径(与本模块同级目录的上一层)
_FASTGPT_SYNC_SCRIPT = str(Path(__file__).resolve().parent.parent.parent / "fastgpt_sync.py")


def send_to_fastgpt(mode="today"):
    """
    调用 fastgpt_sync.py 同步到 FastGPT 知识库。

    参数:
        mode: "today"(仅当天文件,默认)/ "all"(含历史)

    返回:
        True 表示子进程成功退出;False 表示失败。
    """
    if mode not in ("today", "all"):
        raise ValueError(f"mode 必须是 today 或 all,收到: {mode}")

    cmd = [sys.executable, _FASTGPT_SYNC_SCRIPT, "--once", f"--mode={mode}"]
    print(f"[FastGPT] 调用: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, check=False, capture_output=False, text=True)
        if result.returncode == 0:
            print("[FastGPT] ✅ 同步完成")
            return True
        else:
            print(f"[FastGPT] ❌ 同步失败,退出码: {result.returncode}")
            return False
    except Exception as e:
        print(f"[FastGPT] ❌ 调用异常: {e}")
        return False


def run_rag_translation():
    """
    调用 ctgov_full_sync_rag.py 做全文 Markdown 精翻(完整 FastGPT 链路的中间步骤)。
    FastGPT 同步前通常需要先跑这一步把 pending JSON 翻译成 cn/*-zh.md。
    """
    rag_script = str(Path(__file__).resolve().parent.parent.parent / "ctgov_full_sync_rag.py")
    cmd = [sys.executable, rag_script]
    print(f"[RAG] 调用: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, check=False, capture_output=False, text=True)
        return result.returncode == 0
    except Exception as e:
        print(f"[RAG] ❌ 调用异常: {e}")
        return False
