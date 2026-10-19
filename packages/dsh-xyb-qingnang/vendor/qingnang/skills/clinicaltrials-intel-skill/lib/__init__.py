"""
lib - 公共模块包

提供可复用的核心能力,供主程序和各渠道模块集成:
- text_utils:  文本处理工具(文件名清洗、Markdown 转纯文本、分批、列表配置解析)
- llm_client:  LLM 客户端工厂与翻译(消除多文件 LLM 配置副本)
- ctgov_api:   ClinicalTrials.gov 统一抓取(支持 china/top/latest 过滤)
- study_data:  试验数据清洗与本地落地
- channels:    推送渠道包(telegram / gewe / feishu / fastgpt)
"""
