---
name: medical-desensitization
description: 医疗文本与病历脱敏。用于在把病历内容交给任何外部服务之前，先把姓名、身份证号、手机号、住院号、病案号等可识别信息抹掉。当用户提到「脱敏」「去标识化」「病历不能外传」「打码」时使用。属于青囊医学能力包。
---

# medical-desensitization

> ⚠️ **本文件由青囊编写，不是上游产物。**
> 上游 `PancrePal-xiaoyibao/medical-desensitization` 的形态是「Next.js 全栈应用（前端 + Go 后端）」，没有 `SKILL.md`。
> 宿主靠 `SKILL.md` 识别 skill，缺了它这个目录就不会被加载——所以青囊补了这份。
> 上游代码本身**一字未改**；本文件与目录内的 `QINGNANG.md` 是青囊的叠加层。
>
> 许可：**Apache-2.0**（上游 `LICENSE` 已随目录保留）

## 何时用本技能

| 用户说 | 用本技能 |
|---|---|
| 与本目录职责相关的问题 | ✅ |
| 涉及诊断 / 剂量 / 急症判断 | ❌ 触发主技能红线 M1/M2/M4 |
| 需要对病历原文做外部处理 | ❌ 先过本技能脱敏，否则不得出机 |

## 怎么用

1. 前端页面：`npm install && npm run dev`（本目录内运行，端口见上游 README）
2. 后端：`cd backend && go run ./cmd/server`
3. 也可**只借用其脱敏规则**：核心逻辑在上游 `backend/internal/app/desensitize.go` 与前端 `src/` 的规则表，读到规则后由 Agent 就地执行

## 医学红线（**不可协商**）

| # | 红线 | 落到本技能 |
|---|---|---|
| **M1** | 不做诊断 | 只做信息处理，不输出诊断结论 |
| **M2** | 不给用药建议 | 不给剂量、不提示换药停药 |
| **M3** | **隐私不出机** | **本技能的核心职责就是保障这条**；处理结果只能写 `~/.qingnang/private/`（0700） |
| **M4** | 急症先就医 | 命中红旗症状先转介就医 |
| **M5** | 出处标注 | 每条处理结果标明「脱敏后 / 原样」与时间 |

## 与其他部分的关系

- **入口**：医学问题先进 `skills/qingnang/SKILL.md`（总路由）
- **适配层**：同目录 `QINGNANG.md`（许可 + 红线叠加说明）
- **本机画像**：`skills/qingnang/HOST_PROFILE.md`
- **搜索通道**：`skills/qingnang/SEARCH_RUNTIME.md`
