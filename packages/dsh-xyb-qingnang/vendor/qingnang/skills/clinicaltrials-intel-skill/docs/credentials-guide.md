# 凭据申请指南（小白向）

本指南手把手教你申请各推送渠道所需的配置参数。**请逐个渠道按需申请**——不需要的渠道跳过即可（缺凭据的渠道会自动跳过，不影响其他渠道）。

> ⚠️ **合规提醒**：所有渠道的凭据仅供你自己用于临床试验情报推送。请遵守各平台的服务条款，**不要**用于群发广告、骚扰、营销等违规用途，**不要**把凭据分享给他人或提交到公开仓库。本仓库已通过 `.gitignore` 保护 `.env`，请勿手动上传。

---

## 📋 渠道速查

| 渠道 | 是否免费 | 申请难度 | 大致耗时 |
|------|---------|---------|---------|
| Telegram | ✅ 免费 | ⭐ 简单 | 5 分钟 |
| 飞书 | ✅ 免费 | ⭐⭐ 中等 | 15 分钟 |
| GeWe 微信 | 💰 付费 | ⭐ 简单（需购买） | 注册+购买后即时 |
| FastGPT | 需自建/托管 | ⭐⭐⭐ 较高 | 视部署方式 |

---

## 🤖 Telegram（免费，最简单）

Telegram 推送需要一个 **Bot Token**（机器人令牌）和一个 **Chat ID**（目标对话 ID）。

### 第 1 步：创建机器人获取 Token

1. 打开 Telegram，搜索并关注官方机器人 **@BotFather**（带蓝色认证勾 ✅，注意别关注到仿冒账号）。
2. 给 @BotFather 发送：`/newbot`
3. 按提示输入：
   - **机器人名称**（显示名，如 `我的试验情报`）
   - **机器人用户名**（必须以 `bot` 结尾，如 `my_clinical_trials_bot`）
4. 创建成功后，BotFather 会回复一段类似这样的消息：

   ```
   Use this token to access the HTTP API:
   1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```

5. 把 `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ` 这整串复制下来，这就是 **`TELEGRAM_BOT_TOKEN`**。

### 第 2 步：获取 Chat ID

Chat ID 决定机器人把消息发到哪里（个人/群组/频道）。

**发到个人（自己）**：
1. 在 Telegram 搜索你刚创建的机器人，点 **Start** 开始对话（这步必须，否则机器人无法主动发消息给你）。
2. 访问（替换成你的 Token）：
   ```
   https://api.telegram.org/bot<你的TOKEN>/getUpdates
   ```
3. 返回的 JSON 里找 `"chat":{"id":123456789}`，这个数字就是你的 **`TELEGRAM_CHAT_ID`**。

**发到群组**：
1. 创建一个群组，把你的机器人**加进去**（加群时设为成员即可）。
2. 在群里随便发一条消息。
3. 同样访问上面的 `getUpdates` 链接，找群组的 `chat.id`（通常是负数，如 `-1001234567890`）。

### 第 3 步：填入配置

编辑 `.env`：
```bash
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_CHAT_ID=123456789
```

### ✅ 验证

```bash
curl -s "https://api.telegram.org/bot<你的TOKEN>/sendMessage" -d "chat_id=<你的CHAT_ID>" -d "text=测试"
```
能收到「测试」消息即成功。

---

## 🐦 飞书（免费，需创建企业自建应用）

飞书推送需要一个 **自建应用**，获取 App ID、App Secret，并把机器人加进目标群拿到 Chat ID。

### 第 1 步：创建自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)，用飞书账号登录。
2. 进入「开发者后台」→「创建企业自建应用」。
3. 填写应用名称（如 `试验情报推送`）和描述，创建。
4. 在应用详情页的「凭证与基础信息」里，能看到：
   - **App ID**（如 `cli_a1b2c3d4`）→ 这就是 **`FEISHU_APP_ID`**
   - **App Secret**（点显示后复制）→ 这就是 **`FEISHU_APP_SECRET`**

### 第 2 步：添加机器人能力

1. 在应用里找到「添加应用能力」→ 启用「**机器人**」。
2. 配置机器人名称和头像，保存。

### 第 3 步：配置权限

应用需要权限才能发消息。在「权限管理」里开通以下权限：
- `im:chat`（获取群信息）
- `im:message`（发送消息）
- `im:message:send_as_bot`（以机器人身份发消息）

> 权限名可能随平台更新变化，核心是「**向群发送消息**」相关权限。

### 第 4 步：发布应用并加群

1. 在「版本管理与发布」里创建版本并**提交发布**（企业自建应用通常管理员审核即可，个人开发者可直接通过）。
2. 发布后，在飞书客户端**创建一个群**，把刚发布的机器人**添加为群成员**。
3. 获取群 Chat ID：右键群 →「设置」→「群信息」，或在 [开放平台 API 调试台](https://open.feishu.cn/api-explorer) 用 `im/v1/chats` 接口列出群列表，找到目标群的 `chat_id`（如 `oc_a1b2c3d4e5f6`）。

### 第 5 步：填入配置

编辑 `.env`：
```bash
FEISHU_APP_ID=cli_a1b2c3d4
FEISHU_APP_SECRET=你的AppSecret
FEISHU_CHAT_IDS=oc_a1b2c3d4e5f6
# 多个群用逗号分隔: oc_xxx,oc_yyy
```

> 💡 **tenant_access_token**：本系统代码会自动用 App ID + Secret 换取 token，无需手动配置。

---

## 💬 GeWe 微信（付费服务）

微信群推送基于第三方平台 **GeWeChat**，需购买服务。**这是付费渠道**，不强制使用。

### 申请步骤

1. 访问官网：**https://www.geweapi.com/#/newHome**
2. 注册账号，按需**购买服务套餐**（套餐价格和说明见官网，请自行评估）。
3. 购买后在控制台获取：
   - **AppID** → `GEWE_APP_ID`
   - **Token** → `GEWE_TOKEN`
4. 准备目标群：用绑定的微信号加入目标微信群，获取群的 **wxid**（格式如 `12345678901@chatroom`）。获取方式见 GeWeChat 官方文档。
5. 填入配置：
   ```bash
   GEWE_ENABLED=true
   GEWE_APP_ID=你的AppID
   GEWE_TOKEN=你的Token
   GEWE_TO_WXID=["12345678901@chatroom","98765432109@chatroom"]
   ```

> ⚠️ **合规提醒**：使用第三方微信推送服务需自行评估合规风险，遵守微信及平台的使用条款。本系统仅做技术集成，不对第三方服务的合规性负责。如不需要微信推送，保持 `GEWE_ENABLED=false` 即可。

---

## 📚 FastGPT（知识库，需自建或托管）

FastGPT 是开源自建 RAG 知识库平台，用于把翻译后的试验文档建成可问答的知识库。

### 获取配置

1. **部署 FastGPT**：参考 [FastGPT 官方文档](https://doc.fastgpt.in/) 自建（Docker 部署）或使用托管服务。
2. 部署后，在 FastGPT 后台：
   - **API 密钥**：在「API 密钥」里创建，得到 `openapi-xxx` 开头的 key → `FASTGPT_API_KEY`
   - **数据集 ID**：创建一个数据集，复制其 ID → `FASTGPT_DATASET_ID`
3. 填入配置：
   ```bash
   FASTGPT_BASE_URL=https://你的域名/api
   FASTGPT_API_KEY=openapi-你的key
   FASTGPT_DATASET_ID=你的数据集ID
   ```

> 不需要知识库功能？保持相关配置为空即可，系统会跳过 FastGPT 同步。

---

## 🔑 翻译模型 Key（推荐配置，免费额度可用）

中文翻译需要至少 1 个 LLM API Key，推荐 **通义千问**（有免费额度）：

| 模型 | 申请地址 | 环境变量 |
|------|---------|---------|
| 通义千问（推荐） | https://dashscope.console.aliyun.com/ | `QWEN_API_KEY` |
| 智谱 GLM | https://open.bigmodel.cn/ | `ZHIPU_API_KEY` |
| 阶跃星辰 | https://platform.stepfun.com/ | `STEP_API_KEY` |
| Gemini | https://ai.google.dev/ | `GEMINI_API_KEY` |

注册后在控制台「API Keys」里创建并复制 key，填入 `.env` 对应变量即可。多个 key 用逗号分隔会自动轮换 fallback。

> 不配任何 key 也能运行，但推送内容会是**英文原文**（不翻译）。

---

## ✅ 配置完成后

```bash
# 校验配置（看分级报告，🟢越多越完整）
python3 scripts/check_config.py

# 运行
python3 main.py
```

---

## 🛡️ 安全与合规清单

- [ ] 凭据仅供自己使用，未分享给他人
- [ ] `.env` 文件未上传到任何公开仓库（本仓库已用 `.gitignore` 保护）
- [ ] 推送对象是自己拥有权限的群组/对话
- [ ] 推送内容是合法的试验情报，非营销/骚扰信息
- [ ] 第三方服务（GeWeChat 等）的使用符合其服务条款
- [ ] 遵守《网络安全法》及相关法规，不用于任何违法违规用途

如有疑问，优先查阅各平台官方文档和服务条款。
