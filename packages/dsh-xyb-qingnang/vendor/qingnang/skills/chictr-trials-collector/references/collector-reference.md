# ChiCTR 采集器参考

## 命令

```bash
node dist/index.js search [--keyword <文本>] [--registration-number <ChiCTR注册号>] [--year <年份>] [--max-results <1-100>]
node dist/index.js detail --registration-number <ChiCTR注册号>
```

## 参数约束

| 参数 | 约束 | 说明 |
| --- | --- | --- |
| `keyword` | 最长 200 个字符 | 注册题目关键词 |
| `registration-number` | `ChiCTR` + 至少 8 位数字 | 精确检索或详情查询 |
| `year` | 2000 至当前年份 + 1 | 注册年份 |
| `max-results` | 1–100 的整数 | 返回上限；采集器对分页还会设保护上限 |

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `CACHE_DB_PATH` | JSON 缓存文件完整路径；默认用户目录下 `.chictr/cache/chictr_cache.json` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 可选 HTTP(S) 代理 URL |
| `CHALLENGE_COOLDOWN_MS` | 验证码/挑战后的冷却期，默认 10 分钟 |
| `SESSION_MAX_REQUESTS` | 每个浏览器会话最大请求数，默认 40 |
| `SESSION_TTL_MS` | 浏览器会话最长生命周期，默认 8 分钟 |

## 数据质量规则

- 将列表页与详情页视为网页抓取结果，不是规范化临床数据源。
- 列表页 `project_id` 为详情页定位使用的内部标识，不能替代 `registration_number`。
- 页面字段缺失、网站改版、验证码、网络问题都可能造成空字段或失败。
- 采集前后应记录查询条件、采集时间和代码版本；研究决策需回到原始注册页面和权威资料核实。
