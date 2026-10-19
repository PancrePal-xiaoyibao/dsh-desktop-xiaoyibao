export type CapabilityTag =
  | "对话编排"
  | "语音识别"
  | "语音合成"
  | "开放接入"
  | "前端应用"
  | "后端服务";

export interface StackProvider {
  name: string;
  category: string;
  capabilities: CapabilityTag[];
  description: string;
  publicNotes: string[];
}

export interface StackModel {
  name: string;
  vendor: string;
  purpose: string;
  status: "已接入" | "按环境启用" | "待业务确认";
  detail: string;
}

export const partnerStackOverview = {
  title: "小胰宝合作伙伴技术说明",
  subtitle:
    "面向合作伙伴公开展示当前产品所使用的 API 厂商、语音与模型能力，以及对外披露时遵循的信息边界。",
  highlights: [
    {
      label: "前端架构",
      value: "Next.js",
      detail: "负责公开页面、聊天交互与录音采集",
    },
    {
      label: "后端架构",
      value: "Go",
      detail: "独立承接聊天、STT、TTS 与密钥管理",
    },
    {
      label: "披露范围",
      value: "API / 模型 / 用途",
      detail: "公开说明能力来源，不暴露密钥与内部配置",
    },
  ],
};

export const stackProviders: StackProvider[] = [
  {
    name: "FastGPT",
    category: "对话 API / 编排层",
    capabilities: ["对话编排", "开放接入"],
    description:
      "作为聊天能力的上游接入层，承接会话上下文、流式响应与模型服务的统一编排。",
    publicNotes: [
      "后端通过 `/api/chat` 与 FastGPT 兼容接口对接。",
      "当前仓库已明确配置 `CHAT_PROVIDER=fastgpt`。",
      "具体上游大模型可按合作环境单独配置，不在前端代码中写死。",
    ],
  },
  {
    name: "阿里云百炼",
    category: "语音 API",
    capabilities: ["语音识别", "语音合成"],
    description:
      "可用于语音识别与语音合成，适合作为标准化语音能力供应商对外披露。",
    publicNotes: [
      "后端环境模板已包含 STT 与 TTS 的阿里云配置项。",
      "已确认模型配置包含 `paraformer-v1` 与 `qwen3-tts-flash`。",
      "适合在合作方案里作为默认或备选语音能力来源说明。",
    ],
  },
  {
    name: "火山引擎豆包语音",
    category: "语音 API",
    capabilities: ["语音识别", "语音合成"],
    description:
      "用于中文语音交互场景，支持流式识别与合成，适合沉浸式对话体验。",
    publicNotes: [
      "仓库已包含 Doubao STT WebSocket 与 TTS SSE 对接逻辑。",
      "流式语音识别在当前代码中仅豆包路径可用。",
      "适合在公开页中说明为实时语音交互能力来源。",
    ],
  },
  {
    name: "小胰宝自研前后端",
    category: "应用层",
    capabilities: ["前端应用", "后端服务"],
    description:
      "前端负责用户体验与展示，后端负责密钥隔离、能力路由和对外 API 聚合。",
    publicNotes: [
      "前端仓库不直接存放第三方服务密钥。",
      "Go 后端统一代理聊天、语音识别和语音合成请求。",
      "公开披露时可强调“前后端分离、密钥后置、接口可替换”。",
    ],
  },
];

export const stackModels: StackModel[] = [
  {
    name: "paraformer-v1",
    vendor: "阿里云百炼",
    purpose: "语音识别",
    status: "按环境启用",
    detail: "用于将用户上传或采集的语音转写为文本内容。",
  },
  {
    name: "qwen3-tts-flash",
    vendor: "阿里云百炼",
    purpose: "语音合成",
    status: "按环境启用",
    detail: "用于将回复文本转为语音播报，适合低延迟场景。",
  },
  {
    name: "bigmodel",
    vendor: "火山引擎豆包语音",
    purpose: "流式语音识别",
    status: "已接入",
    detail: "用于实时识别中文语音输入，支撑边说边转写的交互体验。",
  },
  {
    name: "seed-tts-2.0",
    vendor: "火山引擎豆包语音",
    purpose: "语音合成",
    status: "已接入",
    detail: "用于中文语音输出，可用于病例讲解、结果播报等场景。",
  },
  {
    name: "聊天模型",
    vendor: "由 FastGPT 对接的上游模型",
    purpose: "对话生成 / 问答 / 引导",
    status: "待业务确认",
    detail:
      "当前仓库未在前端代码中写死具体聊天模型名称，建议在上线前按真实部署环境补充公开型号。",
  },
];

export const disclosurePrinciples = [
  "公开页可以说明已使用的厂商、API 类型、模型名称及用途，但不应暴露密钥、Host 白名单、内部鉴权规则和成本参数。",
  "聊天模型如果会随合作环境切换，建议写成“由统一对话编排层接入的合作模型”，并在确定后补充具体型号。",
  "对外文案优先使用“当前已接入”“支持接入”“按合作环境启用”这三种状态，避免把可扩展能力误写成已上线能力。",
  "如果后续新增供应商，建议只改这一份配置数据，不直接改页面结构，保持公开材料的一致性。",
];

export const architectureFlow = [
  "合作伙伴或终端用户访问小胰宝前端页面。",
  "Next.js 前端负责展示、聊天输入、语音采集与公开信息呈现。",
  "Go 后端统一承接 `/api/chat`、`/api/stt`、`/api/stt/ws`、`/api/tts`。",
  "后端再按配置把请求转发到 FastGPT、阿里云或豆包等上游能力提供方。",
  "所有第三方密钥留在后端环境变量中，前端只持有业务 API 地址。",
];
