# ClinicalTrials.gov API v2 参考文档

## 基础 URL

```
https://clinicaltrials.gov/api/v2/studies
```

免费公开 API，无需 API Key。

## 查询参数

### 搜索类参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `query.cond` | 疾病/条件搜索 | `pancreatic cancer` |
| `query.term` | 自由文本搜索 | `KRAS G12D AND AREA[StartDate]RANGE[2024-01-01,MAX]` |
| `query.locn` | 地点/国家搜索 | `China` / `United States` |
| `query.titles` | 标题搜索 | `KRAS inhibitor` |
| `query.outcome` | 结局指标搜索 | `overall survival` |

### 筛选类参数

| 参数 | 说明 | 可选值 |
|------|------|--------|
| `filter.overallStatus` | 试验状态 | `RECRUITING`, `ACTIVE_NOT_RECRUITING`, `COMPLETED`, `TERMINATED`, `WITHDRAWN`, `SUSPENDED`, `NOT_YET_RECRUITING` |
| `filter.phase` | 临床阶段 | `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4` |
| `filter.studyType` | 研究类型 | `INTERVENTIONAL`, `OBSERVATIONAL`, `EXPANDED_ACCESS` |
| `filter.advanced` | 高级筛选 | 见下方高级语法 |

### 分页参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `pageSize` | 每页结果数 | 10 |
| `pageToken` | 翻页令牌 | — |
| `countTotal` | 是否返回总数 | `false` |

### 输出参数

| 参数 | 说明 | 可选值 |
|------|------|--------|
| `fields` | 返回字段列表 | 见下方字段说明 |
| `format` | 输出格式 | `json`, `csv` |
| `markupFormat` | 标记格式 | `legacy`, `markdown` |

## 时间范围搜索语法

使用 `query.term` 配合 `AREA[字段名]RANGE[起始,结束]` 语法：

```
# 2024年之后启动的试验
query.term = KRAS G12D AND AREA[StartDate]RANGE[2024-01-01,MAX]

# 指定时间范围
query.term = KRAS G12D AND AREA[StartDate]RANGE[2023-01-01,2025-12-31]

# 最近更新的试验
query.term = KRAS G12D AND AREA[LastUpdatePostDate]RANGE[2024-06-01,MAX]
```

可用日期字段：
- `StartDate` — 试验启动日期
- `CompletionDate` — 试验完成日期
- `LastUpdatePostDate` — 最后更新日期
- `PrimaryCompletionDate` — 主要终点完成日期

## 国家/地区搜索

`query.locn` 参数支持：
- 国家英文名：`China`, `United States`, `Japan`, `Germany`
- 城市名：`Beijing`, `Shanghai`
- 州/省名：`California`

多国家搜索用空格分隔：`query.locn = China OR Japan`

## 返回字段说明

### 常用字段列表

```
NCTId,BriefTitle,OfficialTitle,Phase,OverallStatus,Condition,
InterventionName,InterventionType,EligibilityCriteria,
LeadSponsorName,StartDate,LocationCountry,LocationCity,
LocationFacility,LastUpdatePostDate
```

### 字段路径映射

| 字段名 | JSON 路径 |
|--------|-----------|
| NCTId | `protocolSection.identificationModule.nctId` |
| BriefTitle | `protocolSection.identificationModule.briefTitle` |
| OfficialTitle | `protocolSection.identificationModule.officialTitle` |
| Phase | `protocolSection.identificationModule.phase` |
| OverallStatus | `protocolSection.statusModule.overallStatus` |
| Condition | `protocolSection.identificationModule.conditions` |
| InterventionName | `protocolSection.armsInterventionsModule.interventions[].name` |
| InterventionType | `protocolSection.armsInterventionsModule.interventions[].type` |
| EligibilityCriteria | `protocolSection.eligibilityModule.eligibilityCriteria` |
| LeadSponsorName | `protocolSection.sponsorCollaboratorsModule.leadSponsor.name` |
| StartDate | `protocolSection.statusModule.startDateStruct.date` |
| LocationCountry | `protocolSection.contactsLocationsModule.locations[].country` |
| LocationCity | `protocolSection.contactsLocationsModule.locations[].city` |
| LastUpdatePostDate | `protocolSection.statusModule.lastUpdatePostDateStruct.date` |

## 速率限制

- 无官方速率限制文档，建议控制请求频率
- 脚本内置 3 次重试 + 指数退避机制
- 遇到 429 状态码时自动加倍等待时间

## 响应结构示例

```json
{
  "studies": [
    {
      "protocolSection": {
        "identificationModule": {
          "nctId": "NCT07621718",
          "briefTitle": "Study of Zoldonrasib...",
          "phase": ["Phase 3"],
          "conditions": ["Pancreatic Cancer"]
        },
        "statusModule": {
          "overallStatus": "Recruiting",
          "startDateStruct": { "date": "2025-01-15" }
        }
      }
    }
  ],
  "nextPageToken": "abc123..."
}
```
