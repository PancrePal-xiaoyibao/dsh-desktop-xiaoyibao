import type { ComponentType } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  AudioLines,
  Bot,
  Building2,
  CheckCircle2,
  CircleDashed,
  LockKeyhole,
  MessagesSquare,
  Mic,
  ShieldCheck,
  Sparkles,
  Volume2,
  Workflow,
} from "lucide-react";
import {
  architectureFlow,
  disclosurePrinciples,
  partnerStackOverview,
  stackModels,
  stackProviders,
  type CapabilityTag,
} from "@/content/partnerStack";

export const metadata: Metadata = {
  title: "合作伙伴技术说明 | 小胰宝",
  description:
    "面向合作伙伴公开展示小胰宝当前已接入的 API 厂商、模型能力、架构边界与信息披露原则。",
};

const capabilityIconMap: Record<
  CapabilityTag,
  ComponentType<{ className?: string }>
> = {
  对话编排: MessagesSquare,
  语音识别: Mic,
  语音合成: Volume2,
  开放接入: Sparkles,
  前端应用: Bot,
  后端服务: ShieldCheck,
};

const statusClassMap = {
  已接入: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  按环境启用: "bg-amber-100 text-amber-900 ring-amber-200",
  待业务确认: "bg-stone-200 text-stone-700 ring-stone-300",
} as const;

export default function PartnersPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(13,148,136,0.16),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(245,158,11,0.10),_transparent_30%),linear-gradient(180deg,#fcfbf7_0%,#f4ede0_45%,#fcfbf7_100%)] text-stone-900">
      <section className="relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal-500/60 to-transparent" />
        <div className="absolute left-[-10rem] top-24 h-72 w-72 rounded-full bg-teal-200/30 blur-3xl" />
        <div className="absolute right-[-6rem] top-12 h-64 w-64 rounded-full bg-amber-100/70 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.35)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.35)_1px,transparent_1px)] bg-[size:40px_40px] opacity-30" />

        <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-10 px-6 py-8 sm:px-10 lg:px-12">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-sm text-stone-700 shadow-sm backdrop-blur">
              <Building2 className="h-4 w-4 text-teal-700" />
              小胰宝公开合作资料页
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <a
                href="#partners-stack"
                className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-sm font-medium text-stone-700 shadow-sm backdrop-blur transition hover:border-teal-200 hover:text-teal-700"
              >
                查看能力清单
              </a>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-full border border-stone-300/70 px-4 py-2 text-sm font-medium text-stone-700 transition hover:border-teal-700 hover:text-teal-700"
              >
                返回产品首页
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full bg-teal-50 px-3 py-1 text-sm font-medium text-teal-800 ring-1 ring-teal-200">
                <ShieldCheck className="h-4 w-4" />
                对外公开版本
              </div>

              <div className="space-y-4">
                <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl lg:text-6xl">
                  {partnerStackOverview.title}
                </h1>
                <p className="max-w-3xl text-base leading-8 text-stone-600 sm:text-lg">
                  {partnerStackOverview.subtitle}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-stone-900/10">
                  <Workflow className="h-4 w-4 text-teal-300" />
                  统一后端聚合多家 AI 能力
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-white/80 px-4 py-2 text-sm font-medium text-teal-800">
                  <LockKeyhole className="h-4 w-4" />
                  密钥仅保留在后端环境
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                {partnerStackOverview.highlights.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-[1.75rem] border border-white/80 bg-white/85 p-5 shadow-[0_12px_40px_rgba(120,113,108,0.08)] backdrop-blur"
                  >
                    <div className="text-sm text-stone-500">{item.label}</div>
                    <div className="mt-2 text-2xl font-semibold text-stone-900">
                      {item.value}
                    </div>
                    <p className="mt-3 text-sm leading-6 text-stone-600">
                      {item.detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[2rem] border border-stone-200/70 bg-stone-950 p-6 text-stone-100 shadow-[0_22px_60px_rgba(28,25,23,0.24)]">
              <div className="flex items-center gap-3 text-sm font-medium text-teal-300">
                <AudioLines className="h-5 w-5" />
                当前可公开说明的能力边界
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-sm font-semibold text-white">已确认</div>
                  <p className="mt-2 text-sm leading-6 text-stone-300">
                    聊天能力通过 FastGPT 对接，语音识别与语音合成支持阿里云和豆包路径，前后端采用分离式架构。
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-sm font-semibold text-white">建议补充</div>
                  <p className="mt-2 text-sm leading-6 text-stone-300">
                    如果合作方需要精确到聊天模型型号，建议根据真实生产环境补充最终上线模型名称，而不是直接写死在公开页。
                  </p>
                </div>

                <div className="rounded-[1.5rem] bg-gradient-to-r from-teal-500 to-cyan-500 p-[1px]">
                  <div className="rounded-[1.45rem] bg-stone-950 p-4">
                    <div className="text-sm font-semibold text-white">
                      适合对外表达的定位
                    </div>
                    <p className="mt-2 text-sm leading-6 text-stone-300">
                      小胰宝通过统一后端对接多家 AI 能力供应商，并按场景选择对话、语音识别和语音播报服务。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-6 sm:px-10 lg:grid-cols-[0.95fr_1.05fr] lg:px-12">
        <div className="rounded-[2rem] border border-white/80 bg-white/80 p-7 shadow-[0_16px_48px_rgba(120,113,108,0.08)] backdrop-blur">
          <div className="flex items-center gap-3 text-lg font-semibold text-stone-900">
            <Bot className="h-5 w-5 text-teal-700" />
            技术路径概览
          </div>

          <div className="mt-6 space-y-4">
            {architectureFlow.map((step, index) => (
              <div key={step} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white">
                    {index + 1}
                  </div>
                  {index < architectureFlow.length - 1 ? (
                    <div className="mt-2 h-full w-px bg-gradient-to-b from-teal-200 to-transparent" />
                  ) : null}
                </div>
                <p className="pb-5 text-sm leading-7 text-stone-600">{step}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/80 bg-white/85 p-7 shadow-[0_16px_48px_rgba(120,113,108,0.08)] backdrop-blur">
          <div className="flex items-center gap-3 text-lg font-semibold text-stone-900">
            <LockKeyhole className="h-5 w-5 text-teal-700" />
            公开披露原则
          </div>

          <div className="mt-6 grid gap-4">
            {disclosurePrinciples.map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-stone-100 bg-stone-50 p-4 text-sm leading-7 text-stone-600"
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="partners-stack"
        className="mx-auto w-full max-w-7xl px-6 py-6 sm:px-10 lg:px-12"
      >
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-sm font-medium uppercase tracking-[0.24em] text-teal-800/80">
              API 厂商
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">
              当前已确认的能力提供方
            </h2>
          </div>
          <p className="max-w-2xl text-sm leading-7 text-stone-600">
            以下内容基于当前仓库代码和环境模板可确认的信息整理，适合直接作为公开说明的底稿使用。
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {stackProviders.map((provider) => (
            <article
              key={provider.name}
              className="group rounded-[2rem] border border-white/80 bg-white/88 p-6 shadow-[0_14px_40px_rgba(120,113,108,0.08)] backdrop-blur transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_48px_rgba(120,113,108,0.14)]"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-xl font-semibold text-stone-900">
                  {provider.name}
                </div>
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  {provider.category}
                </span>
              </div>

              <p className="mt-4 text-sm leading-7 text-stone-600">
                {provider.description}
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                {provider.capabilities.map((capability) => {
                  const Icon = capabilityIconMap[capability];

                  return (
                    <span
                      key={capability}
                      className="inline-flex items-center gap-2 rounded-full bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-800 ring-1 ring-teal-100"
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {capability}
                    </span>
                  );
                })}
              </div>

              <div className="mt-6 space-y-3">
                {provider.publicNotes.map((note) => (
                  <div
                    key={note}
                    className="rounded-2xl bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600 transition group-hover:bg-teal-50/60"
                  >
                    {note}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-6 py-6 pb-16 sm:px-10 lg:px-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-sm font-medium uppercase tracking-[0.24em] text-teal-800/80">
              模型清单
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">
              当前可以公开展示的模型与用途
            </h2>
          </div>
          <div className="rounded-full border border-stone-200 bg-white/70 px-4 py-2 text-sm text-stone-600">
            建议上线前再核对一次真实生产环境
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {stackModels.map((model) => {
            const StatusIcon =
              model.status === "待业务确认" ? CircleDashed : CheckCircle2;

            return (
              <article
                key={model.name}
                className="rounded-[1.75rem] border border-stone-200/80 bg-white/90 p-5 shadow-[0_12px_36px_rgba(120,113,108,0.08)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_40px_rgba(120,113,108,0.14)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-stone-900">
                      {model.name}
                    </div>
                    <div className="mt-1 text-sm text-stone-500">
                      {model.vendor}
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 ${statusClassMap[model.status]}`}
                  >
                    <StatusIcon className="h-3.5 w-3.5" />
                    {model.status}
                  </span>
                </div>

                <div className="mt-5 rounded-2xl bg-stone-50 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-stone-400">
                    用途
                  </div>
                  <div className="mt-2 text-sm font-medium text-stone-800">
                    {model.purpose}
                  </div>
                </div>

                <p className="mt-4 text-sm leading-7 text-stone-600">
                  {model.detail}
                </p>
              </article>
            );
          })}
        </div>

        <div className="mt-8 rounded-[2rem] border border-teal-100 bg-gradient-to-r from-teal-50 via-white to-cream-100 p-6">
          <div className="text-lg font-semibold text-stone-900">
            对外介绍时可以直接使用的表达
          </div>
          <p className="mt-3 max-w-4xl text-sm leading-7 text-stone-600">
            小胰宝采用前后端分离架构，前端负责用户界面与交互体验，后端统一承接聊天、语音识别和语音合成能力，并按场景接入
            FastGPT、阿里云百炼、火山引擎豆包等服务提供方。公开页面展示厂商与模型用途，但不会暴露密钥、内部路由或敏感配置。
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-[1.75rem] border border-stone-200/70 bg-white/80 px-6 py-5 shadow-[0_12px_36px_rgba(120,113,108,0.08)] backdrop-blur">
          <div>
            <div className="text-sm font-medium text-stone-500">
              如需用于正式对外材料
            </div>
            <div className="mt-1 text-lg font-semibold text-stone-900">
              建议在发布前补充最终聊天模型名称与合作口径版本号
            </div>
          </div>
          <a
            href="#partners-stack"
            className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-teal-700"
          >
            回到能力清单
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>
    </main>
  );
}
