# 配置项参考

逐条说明三层配置（`.env` / `config.yaml` / 命令行参数）。配置模板见 `assets/.env.template` 和 `assets/config.yaml.template`。

## 配置优先级

命令行参数 > `.env`（凭据） / `config.yaml`（行为） > 代码默认值

> 注意：`.env` 放敏感凭据（key/token），`config.yaml` 放行为开关。两者职责分离，凭据绝不写进 `config.yaml`（yaml 会提交 git）。

---

## `.env`（凭据，永不提交 git）

### 翻译模型
| 变量 | 说明 |
|------|------|
| `QWEN_API_KEY` | 通义千问 API key（主力模型，支持逗号分隔多 key 轮换） |
| `ZHIPU_API_KEY` | 智谱 GLM API key |
| `STEP_API_KEY` | 阶跃星辰 API key |
| `GEMINI_API_KEY` | Gemini API key |
| `OPENAI_API_KEY` | OpenAI API key（可选，成本高） |

> 旧版小写变量（`zhipu_api_key` / `gemini_api_key` / `LLM_PROVIDER` 等）保留向后兼容，新代码优先用大写变量 + `config.yaml` 的 `translate_models` 链。

### Telegram
| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（从 @BotFather 获取） |
| `TELEGRAM_CHAT_ID` | 目标 chat id（群/频道/个人） |

### GeWe 微信群
| 变量 | 说明 |
|------|------|
| `GEWE_ENABLED` | 总开关。`false` 跳过；缺 APP_ID/TOKEN/WXID 也自动跳过 |
| `GEWE_API_HOST` | GeWe API host，默认 `api.geweapi.com` |
| `GEWE_APP_ID` | GeWe 应用 ID |
| `GEWE_TOKEN` | GeWe token |
| `GEWE_TO_WXID` | 目标群。JSON 数组 / 逗号分隔 / 单群三种写法 |
| `GEWE_CARD_MODE` | `true` 额外发可跳转卡片；`false` 仅纯文字 |
| `GEWE_MSG_MAX_LEN` | 单条消息长度上限（默认 500，避免微信折叠） |
| `GEWE_PUSH_RETRY_TIMES` | 推送失败重试次数 |
| `GEWE_PUSH_RETRY_DELAY` | 重试间隔秒 |

### 飞书
| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 飞书应用密钥 |
| `FEISHU_CHAT_IDS` | 目标群 ID（逗号分隔） |

### FastGPT
| 变量 | 说明 |
|------|------|
| `FASTGPT_BASE_URL` | FastGPT 实例 URL（含 `/api`） |
| `FASTGPT_API_KEY` | `openapi-` 开头的 API key |
| `FASTGPT_DATASET_ID` | 目标数据集 ID |
| `FASTGPT_LOCAL_DIR` | 本地文档根目录（JSON 数组/逗号分隔） |
| `FASTGPT_CN_SUBDIR` | 中文文档子目录名，默认 `cn` |
| `FASTGPT_FILE_EXTENSIONS` | 扫描的扩展名 |
| `FASTGPT_IGNORE_PATTERNS` | 忽略文件/目录的正则 |
| `FASTGPT_CHUNK_SIZE` | 文本分块大小 |
| `FASTGPT_SYNC_STATE_DB` | 同步指纹库路径 |
| `FASTGPT_PUSH_RETRY_TIMES` | 推送重试次数 |

### 搜索参数
| 变量 | 说明 |
|------|------|
| `SEARCH_CONDITION` | 搜索疾病条件，默认 `Pancreatic Cancer` |
| `KEYWORDS` | 关键词来源。`yaml` / `@yaml` / `auto` / 空 → 从 `assets/pancreatic_targets.yaml` 展开；逗号分隔列表 → 显式覆盖。YAML 分组：core + A（EGFR/MET/HER2/TROP2/CLDN18.2/TF）+ B（MSLN/B7-H3/Nectin-4/NTRK/CDH17/CEACAM5/MTAP）+ C（MUC1/FOLR1/DLL3/CA125） |
| `DAYS_BACK` | 回溯天数，默认 30 |

### 可复用靶点清单
| 文件 | 说明 |
|------|------|
| `assets/pancreatic_targets.yaml` | 胰腺癌靶点权威配置（分组/别名/检索词），其它项目可复制或软链接复用 |
| `lib/targets.py` | 加载/展开/匹配 API：`expand_keywords()` / `resolve_default_keywords()` / `resolve_target_query()` / `match_target()` |

### 单一靶点 CLI
| 参数 | 说明 |
|------|------|
| `--target NAME` | 指定单一靶点；与 YAML 做别名/大小写泛化匹配后，用该靶点 keywords 覆盖默认 KEYWORDS |
| 示例 | `python3 main.py --target CD276 --china --top 10 --send-gewe-txt` |
| 菜单 | 主菜单 `5️⃣ 单一靶点推送`（默认中国中心 + top10 + GeWe 文字） |

---

## `config.yaml`（行为开关，提交 git）

### channels（渠道默认开关）
无 `--send-*` 参数时的默认行为。`true` 默认推送，`false` 需显式开启。

### workflow
| 字段 | 说明 |
|------|------|
| `auto_save_json` | 阶段 1 后是否自动落地 JSON |
| `fastgpt_translate_first` | fastgpt 渠道是否先翻译再同步 |
| `gewe_txt_max_len` | GeWe 文字分批长度上限 |

### translate_models（翻译 fallback 链）
顺序即优先级。每项字段：`name` / `base_url`（须 `/v1` 结尾）/ `model` / `api_key_env`（引用 `.env` 变量名）/ `timeout` / `max_tokens`。

---

## 命令行参数（最高优先级）

### main.py
| 参数 | 说明 |
|------|------|
| `--auto` | 自动全流程（适合 cron） |
| 无参数 | 交互式菜单 |

### push_existing_report.py
| 参数 | 说明 |
|------|------|
| `--latest` | 自动查找最新报告 |
| `--file PATH` | 指定报告文件 |
| `--channels a,b,c` | 指定渠道 |
| `--all-channels` | 推送到全部渠道 |
| `--send-gewe-txt` | 仅推 GeWe 文字 |

### fastgpt_sync.py
| 参数 | 说明 |
|------|------|
| `--once` | 执行一次同步 |
| `--mode today` | 仅当天文件 |
| `--mode all` | 全部含历史 |
