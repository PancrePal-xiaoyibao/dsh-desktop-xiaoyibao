# 架构与历史决策

本文件记录系统架构的关键决策与原因，供排障和扩展时参考。SKILL.md 已覆盖日常使用，这里补充"为什么这么设计"。

## 两阶段分离架构

**问题**：早期实现"单篇下载翻译就推送"，导致：
- 中途某篇翻译失败，后续全部卡住
- 多渠道推送串行，一个渠道慢拖累全部
- 翻译过程中已经推送了不完整内容

**方案**：
- **阶段 1（批量处理）**：一次性完成「抓取 → 过滤 → 全量翻译 → 落地」。所有内容先落地到磁盘（JSON / en/*.md / cn/*-zh.md / telegram_push_report.txt）。
- **阶段 2（多渠道推送）**：各渠道从阶段 1 已落地的内容中**各自消费独立的数据源**，互不阻塞。

```
阶段1 落地的内容      →  阶段2 消费渠道
─────────────────────────────────────────
summary + detail_groups → TG / GeWe 文字
study 对象（内存）       → GeWe 卡片 / 飞书卡片
cn/*-zh.md（磁盘）       → FastGPT 知识库
```

> 规则：阶段 2 任何渠道都不应回头触发翻译。翻译永远在阶段 1 完成。

## FastGPT RAG 三步链路

1. **落地**：study JSON → `output/{date}-Pancreatic_Cancer/{NCT}.json`，`sync_status="pending"`。
2. **精翻**（`ctgov_full_sync_rag.py:run_rag_translation`）：
   - 扫描所有 `sync_status=="pending"` 的 JSON
   - `format_to_markdown_en(study)` → 英文 Markdown
   - `translate_text(全文)` → 中文精翻
   - 落地 `en/{date}-{NCT}-{title}.md` + `cn/{date}-{NCT}-{title}-zh.md`
   - JSON 的 `sync_status` 改为 `"synced"`
3. **同步**（`fastgpt_sync.py --once`）：
   - 扫描所有含 `-zh` 的 `.md`
   - 按 NCT 去重 + 内容 hash 去重
   - 上传到 FastGPT，按父目录名归类集合

## 数据清洗：必须剔除的 JSON 模块

处理原始 study JSON 时强制删除，否则污染 RAG 索引：

- `ancestors`
- `conditionBrowseModule`
- `interventionBrowseModule`
- `derivedSection`

这些模块含大量泛化医学术语，会产生严重索引噪音，降低问答命中率。

## NCT 去重与 Hash 指纹

- **NCT 唯一键**：`NCT\d{8}` 从文件名正则提取。同一试验文件名变化仍识别为同一条。
- **Hash 指纹**：`data/fastgpt_sync_state.json` 记录每个文件内容的 MD5。内容未变化跳过上传，内容变化触发 Updating。
- **集合命名**：`history` 目录统一归 `history` 集合；技术子目录（`zh/cn/en`）向上取业务目录名；普通目录直接用父目录名。

## 渠道模块化（v2.2.0）

推送渠道统一抽到 `lib/channels/<channel>.py`，每个渠道一个模块。主脚本通过统一接口调用，不在主流程里堆 if-else。新增渠道 = 新增一个 `lib/channels/xxx.py` + 在 `config.yaml` 注册开关。

## GeWe 微信群推送要点

- **多群循环**：`GEWE_TO_WXID` 支持 JSON 数组 / 逗号分隔 / 单群，逐群独立重试，失败隔离。
- **可跳转卡片**：基于手动验证通过的 `appmsg` XML 模板，点击跳 ClinicalTrials.gov 详情页。
- **中国优先**：含中国中心的试验，标题前缀 + 描述末尾双重标注 `🇨🇳 中国有中心（优先关注）`。
- **公众号适配**：Markdown 自动转纯文本（`#`→去掉、`**`→去掉、`-`→`•`、`[文](url)`→`文(url)`），按 `GEWE_MSG_MAX_LEN` 分批并加 `(续 i/n)` 尾标。
- **零侵入**：与 TG 并列调用，复用已翻译内容，无额外 LLM 成本；微信失败不影响 TG 主渠道。
