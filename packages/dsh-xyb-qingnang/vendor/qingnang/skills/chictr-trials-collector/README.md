# ChiCTR Trials Collector

独立的中国临床试验注册中心（ChiCTR）公开信息采集器，同时提供可复用的 WorkBuddy Skill。它可按关键词、注册号和年份查询研究列表，并通过注册号获取结构化详情。

> 仅用于公开信息的检索与研究整理。结果不是医疗建议，也不保证完整、实时或无误；重要信息须回到 ChiCTR 原始页面核验。

## 功能

- 关键词、注册号、年份组合检索
- 结构化 JSON 列表与研究详情
- 浏览器会话复用、速率限制、重试、熔断与挑战冷却
- L1 内存 + 原子 JSON 文件持久化缓存（避免原生编译依赖）
- 输入范围与注册号格式校验
- 可独立构建、测试、执行，不依赖原仓库目录

## 安装与运行

**前置条件：** Node.js 22+；首次运行需要下载 Chromium。

```bash
git clone git@github.com:opencare-skillhub/chictr-trials-collector.git
cd chictr-trials-collector
npm install
npx playwright install chromium
npm test
```

搜索：

```bash
node dist/index.js search --keyword "胰腺癌" --year 2026 --max-results 10
```

按注册号获取详情：

```bash
node dist/index.js detail --registration-number ChiCTR2500111173
```

标准输出为 JSON，可重定向到文件：

```bash
node dist/index.js search --keyword "KRAS" --max-results 20 > results.json
```

## WorkBuddy Skill

根目录的 `SKILL.md` 是技能入口说明。将整个目录作为独立技能分发或打包即可；运行采集命令时只依赖该目录内的 `package.json`、`src/` 与本地安装的依赖。

## 配置

| 变量 | 作用 |
| --- | --- |
| `CACHE_DB_PATH` | JSON 缓存文件路径 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 可选 HTTP(S) 代理 URL |
| `CHALLENGE_COOLDOWN_MS` | 验证码后的冷却时间（毫秒） |
| `SESSION_MAX_REQUESTS` | 单浏览器会话最大请求数 |

## 限制与合规

- 采用低频、少量、可追踪的请求策略；不要用本项目规避验证码或访问限制。
- ChiCTR 页面结构变化可能造成字段缺失或解析失败，应保留查询参数与原始来源链接。
- 输出可能包含公开联系人字段；使用与再分发时遵循最小必要原则与适用的数据保护要求。

## 开发

```bash
npm run build
npm test
```

测试覆盖缓存有效期与损坏恢复、熔断器恢复逻辑、请求重试/挑战处理、输入校验等关键运行时路径。

## 发布

查看 [RELEASES.md](RELEASES.md) 了解当前版本、变更范围和升级建议。

## 许可证

MIT。ChiCTR 数据及网站内容的使用应遵循其自身的服务条款和适用规则。
