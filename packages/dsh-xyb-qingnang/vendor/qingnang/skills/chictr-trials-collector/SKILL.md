---
name: chictr-trials-collector
description: This skill should be used when collecting, searching, or retrieving detailed records from the Chinese Clinical Trial Registry (ChiCTR), including keyword searches, ChiCTR registration-number lookups, structured JSON exports, and reproducible clinical-trial collection workflows.
agent_created: true
---

# ChiCTR 临床试验采集

## 概览

从中国临床试验注册中心（ChiCTR）公开页面采集临床试验列表和详情，输出结构化 JSON。将其用于按疾病、药物、干预措施、年份或 ChiCTR 注册号检索研究；不要将结果视为诊断、治疗建议或完整证据库。

## 使用边界

- 仅采集 ChiCTR 公开可访问的信息，并遵守目标站点规则、访问频率限制和适用法律。
- 限制单次 `max-results` 为 1–100；优先使用精确注册号，避免宽泛、高频查询。
- 遇到验证码、访问冷却或页面结构异常时停止重试，记录失败原因；不要尝试绕过验证码或反爬机制。
- 输出结果时保留 `registration_number`、`source_url` 和查询参数，标明采集时间；对网页内容的缺失或变更保持谨慎。
- 采集结果可能含联系人信息。遵循最小必要原则，避免不必要地传播电话和邮箱。

## 独立运行

在本技能根目录执行以下命令：

```bash
npm install
npx playwright install chromium
npm run build
node dist/index.js search --keyword "胰腺癌" --year 2026 --max-results 10
```

按注册号读取详情：

```bash
node dist/index.js detail --registration-number ChiCTR2500111173
```

将标准输出保存为 JSON 文件，标准错误用于显示运行错误。可通过 `CACHE_DB_PATH` 指定 SQLite 缓存路径；可通过 `HTTP_PROXY` 或 `HTTPS_PROXY` 传入有效 HTTP(S) 代理 URL。

## 工作流

1. 明确检索目标：关键词、注册号、年份和结果上限。
2. 对精确研究优先调用 `detail`；对主题扫描调用 `search`，每次限制小批量结果。
3. 检查返回的注册号、标题、注册日期、研究类型和机构；在需要时再逐条获取详情。
4. 记录空结果、解析异常和挑战状态；不要把空结果解释为“没有任何研究”。
5. 在交付中说明查询条件、采集时间、结果数量和数据局限。

## 输出字段

- 列表：`registration_number`、`project_id`、`title`、`study_type`、`registration_date`、`institution`
- 详情：基本信息、联系人、研究设计、伦理信息、主办方、招募信息、干预措施、纳排标准以及 `source_url`（可用时）

详细字段和命令行参数见 [references/collector-reference.md](references/collector-reference.md)。

## 常见失败处理

- **验证码或冷却期**：停止访问，等待冷却，不要并发重试。
- **页面超时**：减少查询范围或结果数量，稍后单次重试。
- **详情缺失**：检查注册号格式；部分历史记录可能缺字段或页面结构不同。
- **解析结果为空**：保留 HTML 结构变化的证据并更新解析器测试，不要缓存空详情作为有效数据。
