# medical-desensitization

病历脱敏工作台。

这个仓库用于演示和交付“小胰宝”中的病历资料脱敏能力：在用户把病历、检查报告和聊天记录发给 AI 之前，先做文本抽取、敏感信息识别与脱敏，再把安全版本送入现有 AI 对话流程。

当前产品定位很明确：

- 主要处理 PDF 病历和纯文本病例资料
- 重点解决姓名、手机号、身份证号、地址、病历编号等敏感信息脱敏
- 输出适合继续发给 AI、继续归档或继续人工整理的安全版本文本

当前仓库交付方式与社区里现有公开 repo 保持一致，优先提供：

- 完整源码
- 清晰的 README
- 本地启动方式
- 交付说明与验收路径

当前默认不是“必须先上线到公网才能看”的项目。没有域名也可以直接本地运行和演示。

## 项目概览

前端和后端现在是彻底分离的两套进程：

- 前端：Next.js，只负责页面、交互、录音采集和调用后端
- 后端：Go，独立提供 `/api/chat`、`/api/stt`、`/api/stt/ws`、`/api/tts`、`/api/desensitize`

密钥只允许存在于 Go 后端环境变量中。前端只持有后端地址，不再包含任何第三方服务代理逻辑。

## 当前能力

- 文本直贴脱敏
- 图片 OCR 抽字后脱敏
- PDF 文本层提取后脱敏
- 批量上传多份病例并合并处理
- 手动选中文字补充脱敏规则
- 批量导出 Markdown 脱敏结果
- 将脱敏后的安全文本直接发送到现有 AI 对话流

## 适用场景

- 医生、运营或患者家属需要先整理病例，再把内容发给 AI 做总结、问答或改写
- 需要把连续性的癌症病例资料先统一脱敏，再进行下一步分析
- 团队内部先输出安全版病例文本，再做归档、分享或二次加工

## 已实现的批量能力

- 批量上传：很多癌症患者的病例是连续性的，现在可以一次上传多份 PDF / 文本 / 图片，并合并到同一个处理流里
- 批量导出：脱敏结果可以导出成 Markdown，便于技术团队继续整理、入库或喂给后续工具
- 规则复用：批量上传后的内容会进入同一个脱敏工作区，适合复用同一套手动补充规则

## 目录结构

- `src/`：前端 UI
- `backend/`：Go 原生后端
- `.env.example`：前端环境变量模板
- `backend/.env.example`：后端环境变量模板

## 演示入口

本地启动后，浏览器打开：

```text
http://localhost:3000
```

首页即为“病历脱敏工作台”。

## 交付说明

详细交付说明见：

- [`MEDICAL_DESENSITIZATION_HANDOFF.md`](./MEDICAL_DESENSITIZATION_HANDOFF.md)

建议演示路径：

1. 打开首页
2. 上传病历图片 / PDF，或直接粘贴文本
3. 如果是连续性病例，可以一次选择多份资料批量上传
4. 点击“开始识别并脱敏”
5. 查看右侧脱敏结果、分类统计和识别明细
6. 如需留档，可点击“导出 Markdown”
7. 如已接入 AI 服务，再点击“发送脱敏文本给 AI”

## 前后端分离约束

- Next.js `src/app/api` 已移除，前端仓库不再提供业务 API
- 豆包 / 阿里云 / chat 的密钥只给 Go 后端
- 前端通过 `NEXT_PUBLIC_API_BASE_URL` 和 `NEXT_PUBLIC_WS_BASE_URL` 访问后端
- 流式语音识别走 Go 后端的 WebSocket，再由 Go 后端代理到上游服务

## 隐私与数据处理

- 原始病历文本、上传文件内容、OCR 结果和脱敏结果默认只在浏览器与 Go 后端内存中处理，不落库保存。
- 只有在用户触发 AI 对话、语音识别或语音播报时，后端才会调用对应第三方服务。
- 生产环境必须只把密钥放在后端环境变量或部署平台 Secret 中，不要提交 `.env`、录音、截图、导出的 Markdown 或真实病历样本。
- 真实患者数据环境不建议开启 `LOG_LEVEL=debug`，除非日志访问和保留周期已经被明确管控。
- 更多安全说明见 [`SECURITY.md`](./SECURITY.md)。

## 启动方式

1. 安装前端依赖

```bash
npm install
```

后端需要 Go 1.25.8 或更高版本；仓库已在 `backend/go.mod` 中锁定该版本，旧版本 Go 在执行 `go run`、`go build`、`go test` 时会继续触发标准库漏洞告警。

2. 配置前端环境变量

根目录创建 `.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
# 可选；不填时默认从 NEXT_PUBLIC_API_BASE_URL 推导
NEXT_PUBLIC_WS_BASE_URL=
```

3. 配置后端环境变量

复制`backend/.env.example` 为 `backend/.env`
Go backend 启动时会自动读取这个文件；如果你已经在 shell 里显式导出同名环境变量，显式值优先，不会被 `backend/.env` 覆盖。

最小配置通常至少包括：

```env
BACKEND_PORT=8080
CORS_ALLOWED_ORIGINS=http://localhost:3000,https://localhost:3000
DATA_DIR=backend/data
LOG_LEVEL=log
MAX_DESENSITIZE_BODY_BYTES=10485760
MAX_DESENSITIZE_FILE_BYTES=20971520
CHAT_PROVIDER=fastgpt
CHAT_API_URL=https://your-fastgpt-host/api/v1/chat/completions
CHAT_API_KEY=fastgpt-app-key
CHAT_REQUEST_TIMEOUT_MS=300000
FASTGPT_STREAM_DETAIL=false
STT_PROVIDER=doubao
TTS_PROVIDER=doubao
DOUBAO_STT_APP_ID=...
DOUBAO_STT_ACCESS_KEY=...
DOUBAO_TTS_APP_ID=...
DOUBAO_TTS_ACCESS_KEY=...
DOUBAO_TTS_SPEAKER=...
```

如果 chat 上游是 FastGPT：

- `CHAT_PROVIDER=fastgpt`
- `CHAT_API_URL` 使用 FastGPT 文档里的 `/api/v1/chat/completions`
- 前端会自动把当前会话 ID 作为 `chatId` 传给后端，后端再转发给 FastGPT
- `FASTGPT_STREAM_DETAIL=false` 时，返回的是 OpenAI 风格 SSE，当前前端可直接解析
- 如果你后续要接 FastGPT 的工作流节点事件，再把 `FASTGPT_STREAM_DETAIL=true`
- `LOG_LEVEL=log` 只输出常规日志；`LOG_LEVEL=debug` 会额外输出上游握手、SSE/STT WebSocket 细节和请求调试信息

4. 启动后端

```bash
npm run dev:backend
```

5. 启动前端

```bash
npm run dev
```

如需 HTTPS 前端开发环境：

```bash
npm run certs
npm run dev:https
```

`npm run certs` 会生成本地开发证书到 `certificates/`。如果电脑已安装 `mkcert`，脚本会优先使用 `mkcert`；否则回退到 `openssl` 生成自签名证书。

## 构建

前端构建：

```bash
npm run build
```

后端构建：

```bash
npm run build:backend
```

前端生产启动：

```bash
npm start
```

后端生产启动：

```bash
go run ./backend/cmd/server
```

## 一体化部署

仓库根目录已经提供单服务部署方案：

- `Dockerfile`：同时构建 Next.js 前端和 Go 后端
- `render.yaml`：可直接导入 Render Blueprint
- 容器内通过 Nginx 暴露单一公网入口
- 公网部署检查清单见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)

这套部署方式的特点：

- 不需要先购买域名
- 前端和后端共用一个公网地址
- 浏览器直接访问同域名，不需要额外处理跨域

在 Render 中部署时，直接导入本仓库即可。服务启动后会得到一个类似 `https://xxx.onrender.com` 的公网地址。

拿到 Render 公网地址后，建议在 Render 环境变量里设置：

```env
CORS_ALLOWED_ORIGINS=https://你的服务名.onrender.com
```

如果要调整上传大小，需要同时保持后端和 Nginx 限制一致，例如：

```env
MAX_DESENSITIZE_FILE_BYTES=20971520
NGINX_CLIENT_MAX_BODY_SIZE=20m
```

如果要让注册账号和历史记录在公网部署后长期保留，需要给 `DATA_DIR` 配持久化存储。Render 上建议挂载持久磁盘，并设置：

```env
DATA_DIR=/var/data
```

如果只做病历脱敏演示，默认配置就可以先跑起来；如果要启用 AI 对话、语音识别、语音播报，再去补充对应环境变量即可。

如果只是对齐社区里现有 repo 的交付方式，则本地运行 + README 说明已经足够，不必强制购买域名。

## 校验

前端：

```bash
npm run lint
npx tsc --noEmit
```

后端：

```bash
npm run test:backend
```

## GitHub 仓库保护

合并前建议先启用 `main` 分支 ruleset，避免直接 push 绕过 CI。具体步骤见 [`.github/BRANCH_PROTECTION.md`](./.github/BRANCH_PROTECTION.md)。

Dependabot 补丁自动合并默认需要仓库变量 `DEPENDABOT_AUTO_MERGE_ENABLED=true` 才会运行。请先确认 `main` 分支保护和 required checks 已经生效，再打开这个变量。

## 已知依赖告警

截至 2026-05-06，`npm audit` 会报告当前最新 `next@16.2.4` 依赖链中的 PostCSS moderate 告警。不要运行 `npm audit fix --force`，因为 npm 当前给出的修复路径会破坏性降级 Next.js。保持 Dependabot 开启，等待 Next.js 发布非破坏性补丁后再升级。

后端：

```bash
npm run test:backend
cd backend && go build ./cmd/server
```
