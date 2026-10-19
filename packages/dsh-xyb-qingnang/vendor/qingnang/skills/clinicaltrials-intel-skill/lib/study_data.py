"""
study_data - 试验数据清洗与本地落地

从原 daily_ctgov_check_tgbot.py 抽取,修复了 save_study_json 的死参 bug
(原第 2 个参数 translated_info 完全未被使用)。

包含:
- clean_study_data: 递归删除 RAG 冗余字段(ancestors / conditionBrowseModule 等)
- save_study_json:  落地单个 study 到 output/{date}-{condition}/{nct_id}.json

文件格式约定(被 ctgov_full_sync_rag.py 消费):
    {
        "retrieved_at": ISO 时间戳,
        "sync_status": "pending",  # RAG 处理后改为 "synced"
        "original": {...清理后的 study 原始数据...},
        ...extra_fields
    }
"""

import copy
import json
import os
from datetime import datetime

from dotenv import load_dotenv

from lib.text_utils import sanitize_filename

load_dotenv()

# 冗余字段黑名单(RAG 不需要)
_REDUNDANT_KEYS = ["ancestors", "conditionBrowseModule", "interventionBrowseModule", "derivedSection"]


def clean_study_data(data):
    """
    深度递归清理数据:删除 ancestors / conditionBrowseModule 等冗余字段。
    原地修改(data 会被改变),与现有行为一致。
    """
    if isinstance(data, dict):
        for key in _REDUNDANT_KEYS:
            if key in data:
                del data[key]
        for key in list(data.keys()):
            clean_study_data(data[key])
    elif isinstance(data, list):
        for item in data:
            clean_study_data(item)


def save_study_json(study_raw, base_dir=None, extra_fields=None,
                    clean=True, condition=None):
    """
    落地单个 study 的 JSON。

    参数:
        study_raw:    原始 study 对象(含 protocolSection)
        base_dir:     落地根目录。None 时用 output/{date}-{condition}
        extra_fields: 额外字段 dict,会合并进 combined_data
                      (如 translated_info、自定义标记等)
        clean:        True 时递归删除冗余字段(默认 True)
        condition:    用于构造目录名的疾病条件。None 时用 SEARCH_CONDITION env

    返回:
        写入的文件绝对路径。失败返回 None。

    修复说明:
        原 daily_ctgov_check_tgbot.py 的 save_study_json 第 2 个参数
        translated_info 完全未被使用(死参),现已改为 extra_fields,真正写入文件。
    """
    nct_id = (study_raw.get("protocolSection", {})
                        .get("identificationModule", {})
                        .get("nctId", "N/A"))
    date_str = datetime.now().strftime('%Y-%m-%d')

    if base_dir is None:
        cond = condition or os.getenv("SEARCH_CONDITION", "Pancreatic_Cancer")
        folder_name = f"{date_str}-{sanitize_filename(cond)}"
        base_dir = os.path.join("output", folder_name)
    os.makedirs(base_dir, exist_ok=True)

    # 深拷贝后清理(避免修改原对象)
    raw_to_save = copy.deepcopy(study_raw) if clean else study_raw
    if clean:
        clean_study_data(raw_to_save)

    # 组装落地数据
    combined_data = {
        "retrieved_at": datetime.now().isoformat(),
        "sync_status": "pending",  # 标记为待深度同步(被 ctgov_full_sync_rag.py 消费)
        "original": raw_to_save
    }
    if extra_fields:
        combined_data.update(extra_fields)

    file_path = os.path.join(base_dir, f"{nct_id}.json")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(combined_data, f, ensure_ascii=False, indent=2)
        return file_path
    except Exception as e:
        print(f"Error saving study JSON ({nct_id}): {e}")
        return None
