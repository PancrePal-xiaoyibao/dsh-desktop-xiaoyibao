"""channels - 推送渠道包

各渠道独立成模块,可单独 import 使用:
- telegram:  Telegram 消息推送
- gewe:      GeWe 个人微信群推送(文字 + appmsg 卡片)
- feishu:    飞书群卡片推送
- fastgpt:   FastGPT 知识库同步(薄封装)
"""

# 渠道名到模块的映射,供 dispatch 使用
CHANNEL_REGISTRY = {
    "tg": "lib.channels.telegram",
    "gewe_card": "lib.channels.gewe",
    "gewe_txt": "lib.channels.gewe",
    "feishu": "lib.channels.feishu",
    "fastgpt": "lib.channels.fastgpt",
}
