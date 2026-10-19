# dsh-xyb-branding

小胰宝社区版的**品牌层**插件。负责把 DSH Desktop 宿主外壳的品牌位替换为「双 logo」呈现。

## 做什么

| 品牌位 | 内容 |
|---|---|
| `sidebar.brand.mark` | **双 logo**：DSH 大肥鱼标记 + 社区小胰宝标记（中间细分隔线） |
| `sidebar.brand.name` | 产品名「小胰宝社区版」 |
| `conversation.hero.brand.mark` | 社区小胰宝标记（对话区只保留小胰宝语境） |

## 为什么不改宿主组件

宿主已提供官方扩展点 `ctx.slots.inject(...)`，上游自己就是用这个机制替换品牌标记的（见 `vendor/dsh-desktop-main/packages/dsh-desktop-client-ui/client.js`）。

**用扩展点的好处**：
- 零宿主源码改动（`dsh-desktop-client-ui` 组件不动）
- 可独立卸载回退
- 上游升级时不受影响

这符合 的 V-2 规则（改造范围限于配置/资产/插件注册/打包参数，不动核心运行时逻辑）。

## 品牌合规

| 项 | 说明 |
|---|---|
| DSH 标记来源 | 上游品牌资产（`vendor/dsh-desktop-main/build/brand-mark.svg` 的 SVG path） |
| 社区小胰宝标记来源 | `docs/prototype-v2.html` 内嵌 logo（提取为 PNG 后内联为 data URI） |
| 产品名 | 小胰宝社区版 / XiaoYiBao Community |
| 社区版标注 | 「社区发行版，非官方产品」 |
| 上游声明 | MIT License · Copyright (c) 2026 DataElement |

上游版权与许可**完整保留**（见仓库根 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`）。

## 形态约束（宿主契约）

客户端文件严格遵循宿主工作台插件契约：

- `window.__ModuleLoader__.load({ id, factory })` 声明模块
- 依赖一律从 `factory(require)` 取（React 走宿主共享实例）
- **零 `import`**、**零 JSX**（用 `React.createElement`）
- 无构建步骤（宿主不替插件构建，客户端文件必须是可直接加载的单文件）

## 资产

| 文件 | 说明 |
|---|---|
| `assets/xyb-logo.png` | 社区小胰宝 logo 原图（从原型提取） |
| `client.js` | 内联 DSH SVG path 与 XYB data URI（运行时零外部资源请求） |

## 许可

MIT（与上游一致）。上游 DSH Desktop 的版权声明归 DataElement。
