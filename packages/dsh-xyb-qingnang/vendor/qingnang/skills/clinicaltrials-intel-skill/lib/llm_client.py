"""
llm_client - 多模型 fallback 翻译客户端

支持:
- 多模型 fallback 链(config.yaml 的 translate_models,顺序即优先级)
- 统一 OpenAI 兼容协议(qwen/zhipu/gemini/openai 都走同一接口)
- 多 API key 轮换(逗号分隔,key 失败时自动换下一个)
- 向后兼容旧配置(LLM_PROVIDER + zhipu_*/gemini_*)

配置来源(优先级高→低):
1. config.yaml 的 translate_models 列表(推荐)
2. .env 的 LLM_PROVIDER + 对应 provider 的 base_url/api_key/model 变量(旧,向后兼容)
"""

import os
import time
from typing import List, Dict, Optional

import urllib3
import yaml
from dotenv import load_dotenv
from openai import OpenAI

# 禁用 SSL 警告(与现有代码行为一致)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

load_dotenv()

# ============ 预置翻译 prompt(供调用方选用)============
# 短字段翻译(标题、状态、适应症等),用于 daily 抓取后的简报
PROMPT_SHORT_FIELD = "你是一个专业的医学翻译，请将以下临床试验相关文本翻译成准确、专业的中文。只返回翻译结果。"

# 全文 Markdown 翻译(用于 RAG 精翻),强调保留结构
PROMPT_FULL_MARKDOWN = (
    "你是一个专业的医学翻译助手。请将以下临床试验全量内容翻译成专业中文。"
    "要求：1. 严格保留原有 Markdown 结构（标题、列表、加粗等）。"
    "2. 术语翻译要极其准确（例如入组标准、研究终点）。"
    "3. 不要输出翻译结果以外的内容。"
)


# ============ 模型配置加载 ============
def _load_translate_models() -> List[Dict]:
    """
    从 config.yaml 加载 translate_models 列表。
    若未配置,自动回退到旧的 LLM_PROVIDER + provider 变量。
    返回模型配置列表,顺序即 fallback 优先级。
    """
    config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml")
    models = []

    # 尝试从 config.yaml 读取
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            translate_models = cfg.get("translate_models", [])
            if translate_models and isinstance(translate_models, list):
                for m in translate_models:
                    if not m.get("base_url") or not m.get("model"):
                        continue
                    # api_key_env 引用 .env 变量
                    env_key = m.get("api_key_env", "")
                    api_key = os.getenv(env_key, "").strip() if env_key else ""
                    if not api_key:
                        # 旧变量名回退(zhipu_api_key / gemini_api_key / qwen_api_key)
                        name_lower = m.get("name", "").lower()
                        if name_lower == "qwen":
                            api_key = os.getenv("qwen_api_key", "").strip()
                        elif name_lower == "glm" or name_lower == "zhipu":
                            api_key = os.getenv("zhipu_api_key", "").strip()
                        elif name_lower == "gemini":
                            api_key = os.getenv("gemini_api_key", "").strip()
                    if not api_key:
                        print(f"⚠️  模型 {m.get('name')} 的 api_key 未配置(检查 {env_key} 或对应 provider 变量),跳过")
                        continue
                    # 多 key 支持(逗号分隔)
                    keys = [k.strip() for k in api_key.split(",") if k.strip()]
                    models.append({
                        "name": m.get("name", "unknown"),
                        "base_url": m["base_url"].rstrip("/"),
                        "model": m["model"],
                        "api_keys": keys,
                        "timeout": int(m.get("timeout", 60)),
                        "max_tokens": m.get("max_tokens"),
                    })
                if models:
                    return models
        except Exception as e:
            print(f"⚠️  读取 config.yaml 失败: {e}")

    # 回退到旧配置(LLM_PROVIDER + provider 变量)
    provider = os.getenv("LLM_PROVIDER", "zhipu").lower()
    if provider == "qwen":
        base_url = os.getenv("qwen_base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        api_key = os.getenv("qwen_api_key", "")
        model = os.getenv("qwen_default_model", "qwen3.6-flash")
    elif provider == "gemini":
        base_url = os.getenv("gemini_base_url", "")
        api_key = os.getenv("gemini_api_key", "")
        model = os.getenv("gemini_model_name", "gemini-3-flash-preview")
    elif provider == "openai":
        base_url = "https://api.openai.com/v1"
        api_key = os.getenv("OPENAI_API_KEY", "")
        model = "gpt-4o-mini"
    else:  # zhipu
        base_url = os.getenv("zhipu_base_url", "https://open.bigmodel.cn/api/paas/v4")
        api_key = os.getenv("zhipu_api_key", "")
        model = os.getenv("zhipu_model_name", "glm-4-air")

    if not api_key or not base_url:
        print(f"⚠️  LLM_PROVIDER={provider} 但 base_url 或 api_key 未配置,LLM 功能将无法使用")
        return []

    keys = [k.strip() for k in api_key.split(",") if k.strip()]
    return [{
        "name": provider,
        "base_url": base_url.rstrip("/"),
        "model": model,
        "api_keys": keys,
        "timeout": 60,
        "max_tokens": None,
    }]


# 模块加载时解析模型列表(单例)
TRANSLATE_MODELS = _load_translate_models()

# 每个模型当前使用的 key 索引(多 key 轮换)
_model_key_index = {m["name"]: 0 for m in TRANSLATE_MODELS}


def _get_current_key(model_cfg: Dict) -> Optional[str]:
    """获取模型当前使用的 API key"""
    keys = model_cfg["api_keys"]
    if not keys:
        return None
    idx = _model_key_index.get(model_cfg["name"], 0) % len(keys)
    return keys[idx]


def _rotate_key(model_cfg: Dict):
    """切换到下一个 API key(多 key 轮换)"""
    name = model_cfg["name"]
    keys = model_cfg["api_keys"]
    if len(keys) > 1:
        _model_key_index[name] = (_model_key_index.get(name, 0) + 1) % len(keys)


def _call_model(model_cfg: Dict, text: str, system_prompt: str, timeout: int) -> Optional[str]:
    """
    用单个模型配置调用 OpenAI 兼容 API。
    成功返回翻译结果,失败返回 None(触发 fallback)。
    """
    api_key = _get_current_key(model_cfg)
    if not api_key:
        return None

    kwargs = {
        "model": model_cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        "temperature": 0.1,
    }
    if model_cfg.get("max_tokens"):
        kwargs["max_tokens"] = model_cfg["max_tokens"]

    try:
        client = OpenAI(
            api_key=api_key,
            base_url=model_cfg["base_url"],
            timeout=timeout,
        )
        response = client.chat.completions.create(**kwargs)
        result = response.choices[0].message.content.strip()
        if not result:
            return None
        return result
    except Exception as e:
        print(f"⚠️  模型 {model_cfg['name']} 调用失败: {e}")
        # 多 key 时切换 key 再试一次
        if len(model_cfg["api_keys"]) > 1:
            _rotate_key(model_cfg)
            try:
                new_key = _get_current_key(model_cfg)
                client = OpenAI(api_key=new_key, base_url=model_cfg["base_url"], timeout=timeout)
                response = client.chat.completions.create(**kwargs)
                result = response.choices[0].message.content.strip()
                if result:
                    return result
            except Exception as e2:
                print(f"⚠️  模型 {model_cfg['name']} 换 key 后仍失败: {e2}")
        return None


# ============ 公共 API ============
def translate_text(
    text: str,
    system_prompt: Optional[str] = None,
    retry: int = 2,
    timeout: int = 60,
) -> str:
    """
    翻译文本为中文,按 fallback 链尝试模型。

    参数:
        text:          待翻译文本(空则返回原文)
        system_prompt: 系统提示词(默认 PROMPT_SHORT_FIELD)
        retry:         失败重试次数(默认 2,向后兼容)
        timeout:       单次请求超时秒数(默认 60)

    返回:
        翻译后的中文文本。所有模型都失败时返回原文(不抛异常)。
    """
    if not text or not text.strip():
        return text or ""

    if system_prompt is None:
        system_prompt = PROMPT_SHORT_FIELD

    if not TRANSLATE_MODELS:
        print("⚠️  无可用翻译模型,返回原文")
        return text

    # 按 fallback 链依次尝试
    for model_cfg in TRANSLATE_MODELS:
        result = _call_model(model_cfg, text, system_prompt, timeout)
        if result is not None:
            return result
        print(f"⚠️  模型 {model_cfg['name']} 失败,尝试下一个 fallback")
        time.sleep(0.5)

    print("⚠️  所有翻译模型都失败,返回原文")
    return text


# ============ 向后兼容 API(供旧代码使用)============
def get_llm_client():
    """
    向后兼容:返回第一个可用模型的 OpenAI 客户端。
    若无可用模型返回 None。
    """
    if not TRANSLATE_MODELS:
        return None
    first = TRANSLATE_MODELS[0]
    api_key = _get_current_key(first)
    if not api_key:
        return None
    return OpenAI(api_key=api_key, base_url=first["base_url"], timeout=first["timeout"])


def get_llm_model():
    """向后兼容:返回第一个可用模型的名称"""
    if not TRANSLATE_MODELS:
        return "unknown"
    return TRANSLATE_MODELS[0]["model"]


# 模块级 client 单例(向后兼容)
client = get_llm_client()


# ============ 工具函数 ============
def get_available_models() -> List[Dict]:
    """返回当前配置的完整模型配置列表(按 fallback 顺序)"""
    return TRANSLATE_MODELS.copy()


def list_models() -> List[str]:
    """列出当前配置的翻译模型(按 fallback 顺序,简要描述)"""
    return [f"{m['name']} ({m['model']})" for m in TRANSLATE_MODELS]


def test_translation(text: str = "Pancreatic cancer clinical trial") -> Dict:
    """
    测试所有模型的翻译能力,返回每个模型的结果或错误。
    用于诊断和验证 fallback 链。
    """
    results = {}
    test_prompt = "翻译成中文,只返回译文"
    for m in TRANSLATE_MODELS:
        start = time.time()
        result = _call_model(m, text, test_prompt, m["timeout"])
        elapsed = time.time() - start
        results[m["name"]] = {
            "model": m["model"],
            "result": result,
            "time": round(elapsed, 2),
            "success": result is not None,
        }
    return results
