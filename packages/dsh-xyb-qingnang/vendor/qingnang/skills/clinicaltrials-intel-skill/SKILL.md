---
name: clinicaltrials-intel
description: 胰腺癌临床试验情报自动化系统的开发与运维技能。从 ClinicalTrials.gov 抓取试验、双路径处理（TG 推送 + 全文精翻）、清洗，并同步到 FastGPT RAG 知识库；支持 Telegram / GeWe 微信群 / 飞书 / FastGPT 多渠道推送。当用户提到临床试验订阅推送、ClinicalTrials.gov 抓取翻译、FastGPT 知识库同步、GeWe/飞书/TG 推送渠道开发、 pancreatic cancer 情报系统、config.yaml 配置或 .env 模板时，使用此技能——即使用户没有明确说"clinicaltrials-intel"。
---

# Clinical Trials Intel Skill

面向胰腺癌（Pancreatic Cancer）临床试验情报自动化系统的开发与运维技能。本技能沉淀了 `clinicaltrials推送和订阅` 项目的架构、运行流程、配置规范和开发约定，帮助在该项目（或同类系统）上快速开发与排障。

---

## 系统是什么

一套闭环情报系统，核心流程：

```
ClinicalTrials.gov API
   └─ 阶段1: 批量处理（抓取 → 精翻 → 落地）
        ├─ output/{Date}-Pancreatic_Cancer/{NCT}.json   (sync_status=pending)
        ├─ cn/{date}-{NCT}-{title}-zh.md                 (中文精翻，FastGPT 同步源)
        └─ telegram_push_report.txt                       (TG/GeWe 简报)
   └─ 阶段2: 多渠道推送（各自消费独立内容源）
        ├─ TG / GeWe 文字   ← 消费 summary + detail_groups
        ├─ GeWe 卡片 / 飞书 ← 消费 study 对象
        └─ FastGPT 知识库   ← 消费 cn/*-zh.md
```

**关键契约（改动代码前必须理解）**：

- JSON 的 `sync_status` 字段是 RAG 与抓取阶段的隐式契约：`pending` → 待翻译，`synced` → 已处理。
- 中文精翻文件统一加 `-zh` 后缀，这是 FastGPT 同步的过滤标识。
- NCT 编号（`NCT\d{8}`）是去重唯一键，从文件名提取，与文件名变化无关。
- 阶段 1 与阶段 2 必须分离：阶段 1 批量落地完成后，阶段 2 各渠道才消费。不要写成"单篇下载翻译就推送"。

---

## 项目布局（改代码先看这里）

```
main.py                  # 主控台：交互菜单 + 自动流程(--auto)
push_existing_report.py  # 独立推送已有报告（补发/测试场景）
daily_ctgov_check_tgbot.py   # 阶段1：抓取 + TG 简报
ctgov_full_sync_rag.py       # RAG 精翻引擎（JSON→en/cn Markdown）
fastgpt_sync.py              # FastGPT 同步引擎（NCT去重+Hash指纹）
config.yaml                  # 渠道开关 + 流程行为 + 翻译模型 fallback 链
.env                         # 凭据（永不提交 git）
lib/
├── config.py            # 配置加载（config.yaml + .env）
├── ctgov_api.py         # ClinicalTrials.gov API v2 封装
├── content_builder.py   # 推送内容构建（summary/detail_groups）
├── llm_client.py        # OpenAI 兼容多模型 fallback 客户端
├── study_data.py        # study 对象处理
├── text_utils.py        # Markdown→纯文本、分批、清洗
└── channels/            # 推送渠道（每个渠道一个模块）
    ├── telegram.py
    ├── gewe.py          # GeWe 微信群（文字+卡片）
    ├── feishu.py        # 飞书交互卡片
    └── fastgpt.py
output/{Date}-Pancreatic_Cancer/   # 落地根目录（gitignore）
├── cn/  en/  {NCT}.json  telegram_push_report.txt
data/fastgpt_sync_state.json       # 同步指纹库（gitignore）
```

新增/修改推送渠道时，统一在 `lib/channels/` 下做模块，**不要**在主脚本里堆 if-else。这是 v2.2.0 已经确立的约定。

---

## 配置体系（三层，按优先级）

1. **`.env`**（凭据，本地存在，禁止提交 git）—— API key、bot token、群 ID。
2. **`config.yaml`**（行为与开关，**禁止提交 git**）—— 渠道默认开关、流程行为、翻译模型 fallback 链。运行时从 `assets/config.yaml.template` 生成。
3. **命令行参数**（最高优先级）—— `--send-xxx` / `--no-channels` 覆盖 config.yaml 默认值。

翻译模型走 **fallback 链**（见 `config.yaml` 的 `translate_models`），顺序即优先级，每个模型走 OpenAI 兼容协议，`api_key_env` 引用 `.env` 里的变量名（敏感信息不写进 yaml）。向后兼容旧的 `LLM_PROVIDER` + 小写变量。

> 配置文件模板见 `assets/config.yaml.template` 和 `assets/.env.template`。本 skill **自带完整业务代码**，clone 后用 `scripts/setup.sh` 一键生成配置并装依赖——详见下方「完整部署」。**不要**把真实凭据写进模板。

---

## 日常运行

```bash
# 激活虚拟环境（推荐 uv）
source .venv/bin/activate

# 交互式菜单（默认仅上传当天）
python3 main.py

# 主菜单快捷推送（无参数进入 interactive_menu）：
#   3️⃣  10 个最近中国试验 → 微信文字 (gewe_txt)   ← 默认开启，开箱即用
#   4️⃣  10 个最近中国试验 → 微信卡片 (gewe_card)  ← 默认关闭，需先在 config.yaml 设 channels.gewe_card: true
#   5️⃣  单一靶点 → 微信文字 (gewe_txt)            ← 手工输入靶点，匹配 assets/pancreatic_targets.yaml 后检索
# 选项 3/4/5 都复用 run_cli_mode 两阶段流程（默认 china=True, latest=True, top=10）。
# 选项 4 在卡片关闭时会拦在抓取前并提示配置，不白跑流程。
# 选项 5 / CLI --target 会做大小写与别名泛化匹配（如 b7h3→B7-H3/CD276）；未命中 YAML 仍可按原文检索。

# 自动全流程（适合 cron）
python3 main.py --auto

# 推送已有报告（补发/测试）
python3 push_existing_report.py --latest --send-gewe-txt
python3 push_existing_report.py --file output/.../telegram_push_report.txt --channels tg,gewe_txt,feishu

# 独立执行单模块
python3 daily_ctgov_check_tgbot.py        # 抓取
python3 ctgov_full_sync_rag.py            # 精翻
python3 fastgpt_sync.py --once --mode=today   # 同步（today | all）
```

---

## 开发与排障约定

- **安全第一**：含真实凭据的文件（`.env`、`sample_gewe_*.py`、`curl_*_push.md`、`kick_off_member.py`、`openclaw.json`）已在 `.gitignore` 中。新增含凭据的文件时，**同步**把它加进 `.gitignore`，永远不要提交密钥。
- **FastGPT 数据清洗**：处理原始 JSON 时强制剔除 `ancestors`、`conditionBrowseModule`、`interventionBrowseModule`、`derivedSection`——这些字段产生索引噪音，降低 RAG 命中率。
- **中国中心高亮**：含中国医院的试验，TG 加 `🇨🇳` 标记，GeWe 卡片在标题前缀 + 描述末尾双重标注 `🇨🇳 中国有中心（优先关注）`。
- **GeWe 文字分批**：单条消息按 `GEWE_MSG_MAX_LEN`（默认 500）分批，避免微信折叠，分批加 `(续 i/n)` 尾标。
- **渠道默认开关**：`gewe_txt=true`、`gewe_card=false`。主菜单快捷推送以**文字为默认入口**（选项 3，开箱即用），卡片下移到选项 4 并提示用户先在 `config.yaml` 开启。新增菜单项时遵循同一原则——默认开启的渠道靠前、默认关闭的渠道带配置提示。
- **推送失败隔离**：多群循环推送时某群失败不影响其他群；微信失败不影响 TG 主渠道。
- **多疾病支持**：疾病由 `.env` 的 `SEARCH_CONDITION` 或命令行 `--condition` 控制，一次运行一种疾病。落地目录、FastGPT 集合自动按疾病分（`output/{date}-{disease}/`）。**不要**为不同疾病新建仓库——配置切换即可。
- **品牌文案通用化**：标题/footer 统一从 `lib/branding.py` 的 `get_title(condition)` / `get_footer(condition)` 取，**不要**在业务代码里硬编码。胰腺癌保持「小胰宝」专属文案（关注小胰宝助手公众号）；其它疾病走通用「小x宝{疾病中文}」文案（关注小胰宝公众号 + github搜索opencare社区）。新增疾病中文映射加到 `branding.py` 的 `_DISEASE_CN`。
- **胰腺癌靶点 YAML（可复用）**：权威清单在 `assets/pancreatic_targets.yaml`（core/A/B/C 分组 + 别名 + 检索词）。抓取默认 `KEYWORDS=yaml` 由此展开；临时覆盖可写逗号列表。其它项目复用：复制该 YAML，或 `from lib.targets import expand_keywords`。增删靶点只改 YAML，不要在业务代码硬编码长关键词串。
- **单一靶点推送**：主菜单选项 5，或 CLI `python3 main.py --target B7H3 --china --top 10 --send-gewe-txt`。匹配逻辑在 `lib.targets.resolve_target_query`（id/name/aliases/keywords/cn_name，大小写与分隔符无关）；命中后用该靶点 keywords+aliases 覆盖默认 KEYWORDS，流程仍是抓取→翻译→GeWe 文字。
- **重试**：同步脚本内置 3 次重试，适配不稳定网络。

更详细的架构与历史决策见 `references/architecture.md`，配置项逐条说明见 `references/config-reference.md`。

---

## 完整部署（开箱可配置）

本 skill **自带完整业务代码**，clone 后一条命令完成可运行配置：

```bash
git clone https://github.com/opencare-skillhub/clinicaltrials-intel-skill.git
cd clinicaltrials-intel-skill
./scripts/setup.sh
```

`setup.sh` 自动完成：① 创建 venv + 装依赖（含主项目漏掉的 PyYAML）② 从模板生成 `.env` 和 `config.yaml`（到仓库根，与 `lib/config.py` 定位一致）③ 创建 `output/` `data/` `cache/` 运行时目录 ④ 打印分级配置指引并调用校验。

### 配置分级（按需填写，零配置也能启动）

| 级别 | 项 | 不配的后果 |
|------|----|-----------|
| 🔴 启动必需 | Python 依赖 | `import` 崩溃（`setup.sh` 已解决） |
| 🟡 中文翻译 | `.env` 里至少 1 个 `*_API_KEY`（推荐 `QWEN_API_KEY`） | 翻译降级为英文原文输出 |
| 🟢 推送渠道 | 各渠道凭据三件套 | 缺凭据的渠道**静默跳过**，不影响其他渠道 |

### 标准部署流程

```bash
./scripts/setup.sh                    # 一键生成配置 + 装依赖
nano .env                             # 编辑 .env 填入真实凭据
python3 scripts/check_config.py       # 校验配置（🟢/🟡/🔴 分级报告）
python3 main.py                       # 运行（必须在本仓库根目录执行）
```

> ⚠️ **运行目录**：`main.py` 调 `load_dotenv()` 无参数，靠 CWD 找 `.env`；`lib/config.py` 用 `__file__` 定位仓库根的 `config.yaml`。**必须在仓库根执行** `python3 main.py`，否则配置加载不到。

---

## 集成为可复用技能

本技能包不绑定特定产品，可独立运行。若想接入 AI 编程助手作为可复用技能，通过软链接挂到通用技能发现路径 `~/.agents/skills`：

```bash
ln -s "$PWD/clinicaltrials-intel-skill" ~/.agents/skills/clinicaltrials-intel
```

或用自带脚本：`./scripts/install.sh`（软链接）/ `--copy`（复制）/ `--uninstall`。源码（可 git 发布）与技能安装位置解耦，更新仓库即更新技能。欢迎用 ZCode 等工具在本仓库基础上开发与贡献。
