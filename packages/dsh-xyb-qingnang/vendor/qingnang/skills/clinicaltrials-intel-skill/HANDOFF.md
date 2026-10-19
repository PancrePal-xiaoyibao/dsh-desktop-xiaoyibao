# Handoff — clinicaltrials-intel v3.1.0

更新日期：2026-07-18  
当前分支：`main`  
远程：`https://github.com/opencare-skillhub/clinicaltrials-intel-skill.git`

---

## 本版目标

1. 将胰腺癌临床检索靶点沉淀为**可复用 YAML**
2. 支持**单一靶点**抓取 → 翻译 → GeWe 文字推送
3. 日报模版展示**检索关键词**，便于理解筛选条件

---

## 关键变更

| 路径 | 说明 |
|------|------|
| `assets/pancreatic_targets.yaml` | 权威靶点清单（core/A/B/C + aliases + keywords） |
| `lib/targets.py` | YAML 加载/展开/别名匹配 API |
| `lib/ctgov_api.py` | 默认 KEYWORDS 支持 `yaml` → 从 YAML 展开 |
| `lib/content_builder.py` | 日报增加「检索关键词」行；接收 keywords/target_label |
| `main.py` | 菜单 5️⃣ + CLI `--target`；两阶段流程透传靶点关键词 |
| `daily_ctgov_check_tgbot.py` | 旧路径汇总同步关键词行 |
| `assets/.env.template` / `references/*` / `SKILL.md` / `README.md` | 配置与文档同步 |

---

## 如何使用

```bash
# 默认走 YAML 全量靶点关键词
# .env: KEYWORDS=yaml

# 单一靶点 CLI
python3 main.py --target B7H3 --china --top 10 --send-gewe-txt

# 交互菜单
python3 main.py   # 选 5️⃣ 输入 b7h3 / CD276 / claudin18.2 等
```

匹配规则（`lib.targets.resolve_target_query`）：
- 大小写不敏感
- 忽略空格 / `-` / `_` / `.`
- 匹配 id / name / aliases / keywords / cn_name
- 未命中 YAML 时仍按原文检索（菜单会确认）

---

## 验证记录（2026-07-18）

- YAML 展开关键词：41 项（含 B7-H3 / CLDN18.2 / MUC16 等）
- 别名匹配：`b7h3`/`CD276`/`claudin18.2`/`HER2`/`ERBB2`/`mesothelin`/`muc16` 均命中
- CLI：`--target B7H3 --china --top 3 --send-gewe-txt` 参数解析通过
- 在线抓取：`B7H3` + 中国中心 top3 → 返回含 `NCT07523529` 等结果
- 日报关键词行格式化：`检索关键词: B7-H3 (CD276)（B7H3 / B7-H3 / CD276）`

> 说明：完整「翻译 + GeWe 实推」依赖本机 `.env` 凭据；本次已验证检索链路与内容模版，未强制实推微信。

---

## 配置优先级

1. CLI `--target` → 该靶点 keywords+aliases 覆盖默认 KEYWORDS  
2. 环境变量 `KEYWORDS=逗号列表` → 显式覆盖 YAML  
3. `KEYWORDS=yaml|@yaml|auto|空` → `assets/pancreatic_targets.yaml`  
4. YAML 缺失 → `lib/targets.py` 内置 fallback  

---

## 维护约定

- **增删靶点只改** `assets/pancreatic_targets.yaml`
- 其它项目复用：复制 YAML，或 `from lib.targets import expand_keywords, resolve_target_query`
- 凭据文件（`.env` / `config.yaml` / `sample_gewe_*.py` 等）保持 gitignore，永不提交
- 品牌文案继续走 `lib/branding.py`，病种切换走 `SEARCH_CONDITION` / `--condition`

---

## 后续可选

- 菜单 5 支持选择「仅 A/B/C 分组」或「多靶点 OR」
- 单一靶点结果过少时自动放宽（去掉 china_only / 扩大 days_back）
- 将 `clinicaltrials-search` 技能的 genes 配置与本 YAML 做单向同步脚本
