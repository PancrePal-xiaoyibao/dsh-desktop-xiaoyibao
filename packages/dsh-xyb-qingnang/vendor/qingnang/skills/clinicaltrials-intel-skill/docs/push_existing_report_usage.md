# 推送已有报告功能使用说明

## 功能概述

`push_existing_report.py` 是一个独立的推送工具，可以将已生成的 `telegram_push_report.txt` 报告文件推送到各个渠道，无需重新抓取和翻译数据。

## 使用场景

- 已经生成了报告文件，需要补发到某个渠道
- 需要将同一份报告推送到多个渠道
- 测试推送功能时，避免重复抓取数据
- 定时任务分离：先生成报告，后续按需推送

## 命令行使用

### 基本用法

```bash
# 推送指定文件到 GeWe 文字
python3 push_existing_report.py --file output/2026-06-17-Pancreatic_Cancer/telegram_push_report.txt --send-gewe-txt

# 推送最新报告到 Telegram
python3 push_existing_report.py --latest --send-tg

# 推送到多个渠道
python3 push_existing_report.py --latest --channels tg,gewe_txt,feishu

# 推送到所有支持的渠道
python3 push_existing_report.py --latest --all-channels
```

### 文件选择参数

- `--file <路径>`: 指定要推送的报告文件路径
- `--latest`: 自动查找并使用最新的报告文件（按修改时间）

**两者必选其一**

### 渠道选择参数

#### 单个渠道
- `--send-tg`: 推送到 Telegram
- `--send-gewe-txt`: 推送到 GeWe 文字（纯文本格式）
- `--send-feishu`: 推送到飞书

#### 多渠道简写
- `--channels <渠道列表>`: 逗号分隔的多个渠道，如 `tg,gewe_txt,feishu`
- `--all-channels`: 推送到所有支持的渠道（tg, gewe_txt, feishu）
- `--no-channels <排除列表>`: 排除指定渠道（与 `--all-channels` 配合使用）

### 不支持的渠道

- `gewe_card`: 需要完整的 study 数据结构，无法从文本报告生成
- `fastgpt`: 需要完整的 Markdown 文件和 JSON 数据，无法从文本报告同步

## 交互式菜单使用

### 方式1：从主菜单进入

```bash
python3 main.py
# 选择 "2️⃣  手动菜单"
# 选择 "6️⃣  推送已有报告到各渠道"
```

### 方式2：快捷命令

在 `main.py` 的手动菜单中选择 "6️⃣  推送已有报告到各渠道"，系统会：

1. **列出可用报告**：显示最近10个报告文件及其时间
2. **选择报告**：输入编号选择要推送的报告（0 = 最新）
3. **选择渠道**：
   - 1️⃣  Telegram
   - 2️⃣  GeWe 文字
   - 3️⃣  飞书
   - 4️⃣  所有渠道
   - 5️⃣  自定义（输入逗号分隔的渠道列表）
4. **自动推送**：执行推送并显示结果

## 报告文件格式

脚本会自动解析 `telegram_push_report.txt` 文件，按分隔符 `==================================================` 切分为：

1. **汇总部分**：包含标题、日期、试验清单
2. **详情分组**：每组包含3个试验的详细信息
3. **结尾部分**：包含致谢信息

推送时会按原始顺序发送各部分内容。

## 示例

### 示例1：测试推送

```bash
# 先生成报告（不推送）
python3 main.py --china --top 5

# 查看生成的报告
ls -lt output/*/telegram_push_report.txt | head -1

# 测试推送到 GeWe 文字
python3 push_existing_report.py --latest --send-gewe-txt
```

### 示例2：补发到某个渠道

```bash
# 如果之前只推送了 Telegram，现在补发到微信
python3 push_existing_report.py \
  --file output/2026-06-17-Pancreatic_Cancer/telegram_push_report.txt \
  --send-gewe-txt
```

### 示例3：推送到所有渠道

```bash
# 推送最新报告到所有渠道
python3 push_existing_report.py --latest --all-channels

# 推送到所有渠道，但排除 Telegram
python3 push_existing_report.py --latest --all-channels --no-channels tg
```

## 注意事项

1. **环境配置**：确保 `.env` 文件中配置了对应渠道的 API 密钥和参数
2. **渠道限制**：
   - `gewe_card` 和 `fastgpt` 不支持从文本报告推送
   - 飞书推送使用纯文本格式，不支持富文本
3. **文件路径**：支持相对路径和绝对路径
4. **推送频率**：GeWe 推送有频率限制，脚本会自动处理重试

## 错误处理

- 如果文件不存在，会提示错误并退出
- 如果未指定推送渠道，会提示错误
- 如果某个渠道推送失败，不影响其他渠道继续推送
- 最终会显示成功/失败的渠道统计

## 与现有流程的集成

这个工具完全独立于主流程，可以：

1. **分离生成与推送**：使用 `main.py --china --top 10` 仅生成报告，然后根据需要选择推送时机和渠道
2. **测试新渠道**：先生成一次报告，然后多次测试不同渠道的推送效果
3. **定时推送**：配合 cron 或其他定时任务工具，在不同时间推送到不同渠道
4. **批量补发**：对历史报告批量推送到新增的渠道

## 相关文件

- `push_existing_report.py`: 独立推送脚本
- `main.py`: 主控台（包含菜单入口）
- `lib/channels/telegram.py`: Telegram 推送模块
- `lib/channels/gewe.py`: GeWe 推送模块
- `lib/channels/feishu.py`: 飞书推送模块
- `.env`: 环境配置文件
- `config.yaml`: 渠道默认配置

## 技术实现

- 自动识别报告文件格式并解析
- 支持 Markdown 转纯文本（用于 GeWe）
- 支持长文本自动分批（避免超过单条消息限制）
- 支持多群广播（自动向所有配置的群推送）
- 支持失败重试机制
