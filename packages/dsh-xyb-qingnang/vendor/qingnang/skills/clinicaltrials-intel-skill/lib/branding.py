"""
branding - 品牌文案生成(按疾病区分胰腺癌与通用)

胰腺癌保持原有「小胰宝」品牌文案;其它疾病使用通用「小x宝」品牌文案,
标题会带上疾病名。所有标题/footer 统一从这里取,避免散落硬编码。

判定逻辑:condition 包含 "pancreatic"(不分大小写)视为胰腺癌,走专属文案;
         其它一律走通用文案。
"""
import os

from dotenv import load_dotenv

load_dotenv()

# 胰腺癌专属文案(保持原样,不变)
PANCREATIC_TITLE = "🏥 小胰宝临床情报小组日报"
PANCREATIC_FOOTER = ("** 以上由小胰宝社区志愿者 ❤️ 服务提供，支持公益社区发展，"
                     "关注“小胰宝助手”公众号，携手推动社区公益发展！")

# 通用文案(非胰腺癌疾病)
GENERIC_FOOTER = ("** 以上由小x宝社区志愿者 ❤️ 服务提供，支持公益社区发展，"
                  "关注“小胰宝”公众号，github搜索opencare社区，携手推动患者关怀公益发展！")

# 疾病英文名 → 中文展示名映射(标题里用中文更友好)
# 未命中的疾病回退为原文 condition(去首尾空格)
_DISEASE_CN = {
    "pancreatic cancer": "胰腺癌",
    "breast cancer": "乳腺癌",
    "lung cancer": "肺癌",
    "colorectal cancer": "结直肠癌",
    "liver cancer": "肝癌",
    "gastric cancer": "胃癌",
    "prostate cancer": "前列腺癌",
    "leukemia": "白血病",
    "lymphoma": "淋巴瘤",
}


def is_pancreatic(condition: str) -> bool:
    """判断是否胰腺癌(condition 为空时回退到 .env 的 SEARCH_CONDITION)"""
    cond = (condition or os.getenv("SEARCH_CONDITION", "")).strip().lower()
    return "pancreatic" in cond


def disease_cn_name(condition: str) -> str:
    """返回疾病的中文展示名(用于标题)。未映射则原样返回。"""
    cond = (condition or "").strip()
    if not cond:
        cond = os.getenv("SEARCH_CONDITION", "").strip()
    return _DISEASE_CN.get(cond.lower(), cond) if cond else ""


def get_title(condition: str = None) -> str:
    """
    返回日报标题。
    - 胰腺癌: 🏥 小胰宝临床情报小组日报
    - 其它:   🏥 小x宝{疾病中文}临床情报小组日报
    """
    if is_pancreatic(condition):
        return PANCREATIC_TITLE
    name = disease_cn_name(condition) or "临床"
    return f"🏥 小x宝{name}临床情报小组日报"


def get_footer(condition: str = None) -> str:
    """
    返回 footer 文案。
    - 胰腺癌: 小胰宝专属 footer(关注小胰宝助手公众号)
    - 其它:   通用 footer(关注小胰宝公众号 + github搜索opencare社区)
    """
    return PANCREATIC_FOOTER if is_pancreatic(condition) else GENERIC_FOOTER
