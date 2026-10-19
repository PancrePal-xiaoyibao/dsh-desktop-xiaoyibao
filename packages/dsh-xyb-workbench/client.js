/**
 * dsh-xyb-workbench — 小胰宝工作台（客户端入口）
 *
 * 形态遵循宿主工作台契约（vendor/dsh-desktop-main/docs/workbench-standard.zh.md §3.5）：
 * - window.__ModuleLoader__.load({ id, factory })
 * - 依赖一律从 factory(require) 取，**不写 import**（写了就加载失败）
 * - **不引入独立 React**（会出现双实例导致 hooks 报错）
 * - **不引入构建步骤**（宿主不替插件构建，客户端文件必须可直接加载）
 * - 用 React.createElement（别名 h），不用 JSX
 *
 * 本文件是 M1/M6 的界面：工作台注册 + 看板页。
 * 后续 CHG 在此文件内按模块追加视图（保持单文件、按模块分区）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-xyb-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API_BASE = '/api/xyb'
    const PRODUCT = '小胰宝'

    // ─────────────────────────────── 样式（内联注入，避免外部资源）
    const STYLE_ID = 'xyb-workbench-style'
    const CSS = `
      /* ────────────────────────────────────────────────
         设计 token（数值真源见仓库文档，不在界面显示）
         美术基因：主 = 清晰理性·瑞士平面（code-genes/01）；
                   辅 = 东方古韵·中国画留白（code-genes/03，只点一层：标题层宋体 + 气口 + 题款竖线）
         颜色严格语义化：红只代表警报，不用作装饰。
         ──────────────────────────────────────────────── */
      :root {
        --xyb-ink:#1B3A34; --xyb-muted:#5A6E68; --xyb-faint:#8FA39C;
        --xyb-green:#0F7C72; --xyb-green-dark:#0A5A53; --xyb-green-light:#95D0C7;
        --xyb-wash:#F2F8F6; --xyb-line:#D7E5E0; --xyb-surface:#FFFFFF; --xyb-on-accent:#FFFFFF;
        --xyb-good:#2E7D5B; --xyb-good-bg:#E8F5EE; --xyb-good-line:#9CCFB4;
        --xyb-watch:#B8860B; --xyb-watch-bg:#FFF6DC; --xyb-watch-line:#E4CE8A;
        --xyb-alert:#C0392B; --xyb-alert-bg:#FCEBE8; --xyb-alert-line:#E8AFA6;
        --xyb-plum:#655472; --xyb-plum-bg:#F1F0F6; --xyb-plum-line:#C4BBD2;
        --xyb-dash:#B9C9C3; --xyb-dash-soft:#C7D8CC; --xyb-note-bg:#F8FAF8;
        --xyb-r-card:12px; --xyb-r-control:8px; --xyb-r-pill:999px;
        --xyb-font-sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
        --xyb-font-serif:"Noto Serif SC","Songti SC","SimSun",serif;
        --xyb-t-h1:29px; --xyb-t-h2:20px; --xyb-t-body:14px; --xyb-t-small:11.5px;
        --xyb-lh-body:1.75; --xyb-lh-tight:1.35;
        --xyb-s1:4px; --xyb-s2:8px; --xyb-s3:12px; --xyb-s4:16px; --xyb-s5:24px; --xyb-s6:32px;
        --xyb-focus:3px solid rgba(15,124,114,.35);
        --xyb-motion:140ms;
      }
      .xybRoot { display:flex; flex-direction:column; height:100%; min-height:0;
                 font-family:var(--xyb-font-sans);
                 color:var(--xyb-ink); background:var(--xyb-wash); }
      .xybHeader { padding:14px 20px 10px; border-bottom:1px solid var(--xyb-line); background:var(--xyb-surface); }
      .xybHeader h1 { margin:0; font-family:var(--xyb-font-serif); font-size:17px; font-weight:600; }
      .xybHeader p { margin:4px 0 0; font-size:12px; color:var(--xyb-muted); }
      .xybBody { flex:1; min-height:0; overflow:auto; padding:16px 20px 28px; }
      .xybVerdict { display:flex; align-items:baseline; gap:10px; padding:14px 16px;
                    border-radius:var(--xyb-r-card); margin-bottom:16px; border:1px solid; }
      .xybVerdict strong { font-size:19px; }
      .xybVerdict span { font-size:12px; opacity:.85; }
      .xybVerdict.good    { background:var(--xyb-good-bg); border-color:var(--xyb-good-line); color:var(--xyb-good); }
      .xybVerdict.watch   { background:var(--xyb-watch-bg); border-color:var(--xyb-watch-line); color:var(--xyb-watch); }
      .xybVerdict.alert   { background:var(--xyb-alert-bg); border-color:var(--xyb-alert-line); color:var(--xyb-alert); }
      .xybVerdict.unk     { background:var(--xyb-plum-bg); border-color:var(--xyb-plum-line); color:var(--xyb-plum); }
      .xybRow { display:flex; align-items:center; gap:10px; width:100%; text-align:left;
                padding:12px 14px; border:1px solid var(--xyb-line); border-radius:10px;
                background:var(--xyb-surface); margin-bottom:8px; cursor:pointer; font:inherit; color:inherit; }
      .xybRow:hover { border-color:var(--xyb-green-light); }
      .xybDot { width:9px; height:9px; border-radius:50%; flex:none; }
      .xybDot.good  { background:var(--xyb-good); }
      .xybDot.watch { background:var(--xyb-watch); }
      .xybDot.alert { background:var(--xyb-alert); }
      .xybDot.unk   { background:var(--xyb-dash); }
      .xybName { font-weight:600; font-size:14px; min-width:74px; }
      .xybVal { flex:1; font-size:13px; color:var(--xyb-ink); font-variant-numeric:tabular-nums; }
      .xybLv { font-size:12px; padding:2px 8px; border-radius:var(--xyb-r-pill); border:1px solid;
               font-variant-numeric:tabular-nums; }
      .xybLv.good  { color:var(--xyb-good); background:var(--xyb-good-bg); border-color:var(--xyb-good-line); }
      .xybLv.watch { color:var(--xyb-watch); background:var(--xyb-watch-bg); border-color:var(--xyb-watch-line); }
      .xybLv.alert { color:var(--xyb-alert); background:var(--xyb-alert-bg); border-color:var(--xyb-alert-line); }
      .xybLv.unk   { color:var(--xyb-plum); background:var(--xyb-plum-bg); border-color:var(--xyb-plum-line); }
      .xybNote { margin:0 0 10px 23px; padding:10px 12px; font-size:12.5px; line-height:1.6;
                 color:var(--xyb-muted); background:var(--xyb-note-bg);
                 border-left:3px solid var(--xyb-green-light); border-radius:0 var(--xyb-r-control) var(--xyb-r-control) 0; }
      .xybMeta { display:flex; justify-content:space-between; font-size:12px; color:var(--xyb-muted);
                 margin:14px 0 4px; font-variant-numeric:tabular-nums; }
      .xybEmpty { text-align:center; padding:40px 20px; color:var(--xyb-muted); }
      .xybEmpty strong { display:block; font-size:15px; color:var(--xyb-ink); margin-bottom:6px; }
      .xybEmpty p { margin:0; font-size:13px; line-height:var(--xyb-lh-body); }
      .xybForm { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; justify-content:center; }
      .xybForm input { height:40px; padding:0 12px; border:1px solid var(--xyb-line); border-radius:var(--xyb-r-control);
                       font:inherit; font-size:13px; background:var(--xyb-surface); color:inherit; }
      .xybDisclaimer { margin-top:18px; padding-top:12px; border-top:1px solid var(--xyb-line);
                       font-size:11.5px; line-height:var(--xyb-lh-body); color:var(--xyb-muted); }
      .xybLoading { padding:40px 20px; text-align:center; color:var(--xyb-muted); font-size:13px; }
      .xybError { padding:14px 16px; border-radius:var(--xyb-r-control); background:var(--xyb-alert-bg);
                  border:1px solid var(--xyb-alert-line); color:var(--xyb-alert); font-size:13px; line-height:1.6; }

      /* ───── 按钮三档（瑞士平面：flat、单一强调色；四态齐全）───── */
      .xybBtn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
                min-height:40px; padding:0 16px; border-radius:var(--xyb-r-control);
                border:1px solid var(--xyb-line); background:var(--xyb-surface); color:var(--xyb-green);
                font:inherit; font-size:13px; font-weight:560; cursor:pointer;
                transition:background var(--xyb-motion) ease-out, border-color var(--xyb-motion) ease-out,
                           color var(--xyb-motion) ease-out, transform var(--xyb-motion) ease-out; }
      .xybBtn:hover { background:var(--xyb-wash); border-color:var(--xyb-green-light); }
      .xybBtn:active { transform:translateY(1px); }
      .xybBtn:disabled { opacity:.45; cursor:not-allowed; }
      .xybBtn:disabled:hover { background:var(--xyb-surface); border-color:var(--xyb-line); }
      .xybBtn--primary { background:var(--xyb-green); border-color:var(--xyb-green); color:var(--xyb-on-accent); }
      .xybBtn--primary:hover { background:var(--xyb-green-dark); border-color:var(--xyb-green-dark); }
      .xybBtn--primary:disabled:hover { background:var(--xyb-green); border-color:var(--xyb-green); }
      .xybBtn--ghost { border-color:transparent; background:transparent; }
      .xybBtn--ghost:hover { background:var(--xyb-wash); border-color:transparent; }

      /* 题款竖线（辅基因唯一落点之一）：区块标题左侧 2px，颜色取强调色 */
      .xybSecTitle { display:flex; align-items:center; gap:8px; font-family:var(--xyb-font-serif);
                     font-size:var(--xyb-t-h2); font-weight:620; line-height:var(--xyb-lh-tight); }
      .xybSecTitle::before { content:''; width:2px; height:1.1em; background:var(--xyb-green); border-radius:1px; }
      .xybWatchMain { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:left; }
      .xybWatchMain .xybVal { flex:initial; }
      .xybSec { margin-bottom:var(--xyb-s6); }
      .xybTabsLine { font-size:12px; color:var(--xyb-muted); }

      /* 可访问性：键盘焦点环 + 减动效 */
      .xybShell button:focus-visible, .xybShell select:focus-visible, .xybShell input:focus-visible,
      .xybShell [tabindex]:focus-visible {
        outline:var(--xyb-focus); outline-offset:2px;
      }
      @media (prefers-reduced-motion: reduce) {
        .xybShell *, .xybShell *::before, .xybShell *::after {
          transition:none !important; animation:none !important; scroll-behavior:auto !important;
        }
      }

      /* ───── customFrame 外壳（对齐 docs/prototype-v2.html 的完整布局）───── */
      /* 界面大小三档（中老年可读性）：用 CSS zoom 整体缩放 —— 文字与按钮点击区一起变大，
         比只放大字号更符合「看得清 + 点得准」；不碰任何数据与存储。
         值挂在根节点 data-text-scale，与 localStorage 的 xyb:text-scale:v1 同步。 */
      .xybShell { display:flex; flex-direction:column; height:100%; min-height:0; width:100%; position:relative;
                  background:var(--xyb-surface); color:var(--xyb-ink);
                  font-family:var(--xyb-font-sans); zoom:var(--xyb-zoom,1); }
      .xybShell[data-text-scale="large"] { --xyb-zoom:1.15; }
      .xybShell[data-text-scale="xlarge"] { --xyb-zoom:1.32; }
      .xybTop { display:flex; align-items:center; gap:14px; flex-wrap:wrap;
                /* 宿主为 customFrame 根节点预留的窗口按钮避让（见 workbench-standard §4） */
                padding:10px 18px 10px calc(var(--dsh-frame-leading-clearance, 0px) + 18px);
                border-bottom:1px solid var(--xyb-line); background:var(--xyb-surface); }
      .xybBrand { display:flex; align-items:center; gap:8px; font-family:var(--xyb-font-serif);
                  font-size:17px; font-weight:650; letter-spacing:.01em; }
      .xybBrandLogo { display:block; height:34px; width:auto; flex:none; }
      /* 品牌外链：用链接语义（宿主 security.ts 的 setWindowOpenHandler → shell.openExternal
         会把它交给系统浏览器），不自造 IPC；悬停与聚焦态按 token 系统给反馈 */
      .xybBrandLink { display:inline-flex; align-items:center; gap:9px; text-decoration:none; color:inherit;
                      border-radius:var(--xyb-r-control); }
      .xybBrandLink:hover { background:var(--xyb-wash); }
      .xybLockupLink { display:inline-flex; align-items:center; text-decoration:none; border-radius:var(--xyb-r-control); }
      .xybLockupLink:hover { outline:1px solid var(--xyb-line); }
      .xybAboutLink { display:inline-flex; align-items:center; text-decoration:none; border-radius:var(--xyb-r-control); }
      .xybAboutLink:hover { outline:1px solid var(--xyb-line); }
      .xybLink { color:var(--xyb-green-dark); text-decoration:underline; text-underline-offset:2px; }
      /* 界面大小三档控（中老年可读性）：标准 / 大字 / 特大 */
      .xybTextScale { display:inline-flex; align-items:center; gap:2px; padding:2px; flex:none;
                      border:1px solid var(--xyb-line); border-radius:var(--xyb-r-control); background:var(--xyb-wash); }
      .xybTextScale button { font:inherit; font-size:12px; line-height:1; padding:6px 10px; border:0; cursor:pointer;
                             background:transparent; color:var(--xyb-muted); border-radius:calc(var(--xyb-r-control) - 2px); }
      .xybTextScale button:hover { color:var(--xyb-ink); }
      .xybTextScale button[aria-pressed="true"] { background:var(--xyb-green); color:var(--xyb-on-accent); font-weight:600; }
      .xybTopSpacer { flex:1; }
      .xybPicker { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--xyb-muted); }
      .xybPicker select { height:32px; min-height:32px; padding:0 8px; border:1px solid var(--xyb-line);
                          border-radius:var(--xyb-r-control); background:var(--xyb-surface);
                          color:inherit; font:inherit; font-size:13px; }
      .xybLocal { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--xyb-muted); }
      .xybLocal i { width:7px; height:7px; border-radius:50%; background:var(--xyb-good); display:inline-block; }
      .xybTopBtn { height:32px; min-height:32px; padding:0 12px; border-radius:var(--xyb-r-control);
                   border:1px solid var(--xyb-line); background:var(--xyb-surface); color:var(--xyb-green);
                   font:inherit; font-size:12.5px; font-weight:560; cursor:pointer;
                   transition:background var(--xyb-motion) ease-out, border-color var(--xyb-motion) ease-out; }
      .xybTopBtn:hover { background:var(--xyb-wash); border-color:var(--xyb-green-light); }
      .xybTopBtn:active { transform:translateY(1px); }
      .xybTopBtn[data-on='true'] { background:var(--xyb-green); border-color:var(--xyb-green); color:var(--xyb-on-accent); }
      .xybTabs { display:flex; align-items:center; gap:4px; flex-wrap:wrap; padding:8px 16px;
                 border-bottom:1px solid var(--xyb-line); background:var(--xyb-wash); }
      .xybTab { display:inline-flex; align-items:center; gap:7px; height:34px; min-height:34px; padding:0 13px;
                border-radius:var(--xyb-r-control); border:1px solid transparent; background:transparent;
                color:var(--xyb-ink); font:inherit; font-size:13.5px; font-weight:560; cursor:pointer;
                transition:background var(--xyb-motion) ease-out, border-color var(--xyb-motion) ease-out; }
      .xybTab:hover { background:var(--xyb-surface); }
      .xybTab[aria-selected='true'] { background:var(--xyb-surface); border-color:var(--xyb-line);
                                      box-shadow:0 1px 2px rgba(27,58,52,.06); }
      .xybTabNum { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px;
                   border-radius:5px; background:var(--xyb-good-bg); color:var(--xyb-green-dark);
                   font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }
      .xybMain { flex:1; min-height:0; display:flex; align-items:stretch; }
      .xybPage { flex:1; min-width:0; min-height:0; overflow:auto; padding:18px 20px 28px; }
      /* 页面内容宽度：**不设上限，铺满可用宽度**。
         血的教训（两轮实测反馈）：
           · 占位块写死 max-width:560px → 右侧大片空白 ✗
           · 给 .xybPage > * 套 1180px 上限 → 看板等栅格页被整片截断 ✗（比原问题更糟）
         这些页面是**卡片栅格**，不是长文，不该按「阅读行长」限宽。 */
      .xybChat { display:flex; flex-direction:column; width:clamp(340px, 30%, 520px);
                 min-width:340px; max-width:52%;
                 border-left:1px solid var(--xyb-line); background:var(--xyb-note-bg); }
      .xybChat[data-open='false'] { display:none; }
      .xybChatHead { display:flex; align-items:center; justify-content:space-between; gap:8px;
                     padding:10px 14px; border-bottom:1px solid var(--xyb-line); font-size:13px; font-weight:600; }
      .xybChatBody { flex:1; min-height:0; display:flex; flex-direction:column; }
      .xybChatMount { flex:1; min-height:0; display:flex; flex-direction:column; }
      .xybChatEmpty { padding:18px 16px; font-size:12.5px; line-height:var(--xyb-lh-body); color:var(--xyb-muted); }
      .xybTodo { max-width:none; padding:18px 18px 20px; border:1px dashed var(--xyb-dash-soft);
                 border-radius:var(--xyb-r-card); background:var(--xyb-note-bg); }
      .xybTodo strong { display:block; font-size:15px; margin-bottom:6px; }
      .xybTodo p { margin:0 0 8px; font-size:13px; line-height:var(--xyb-lh-body); color:var(--xyb-muted); }
      .xybTodoNote { color:var(--xyb-plum); }

      /* 病情整理 */
      .xybChips { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 14px; }
      .xybChip { height:30px; min-height:30px; padding:0 12px; border-radius:var(--xyb-r-pill);
                 border:1px solid var(--xyb-line); background:var(--xyb-surface); color:var(--xyb-ink);
                 font:inherit; font-size:12.5px; cursor:pointer; }
      .xybChip:hover { border-color:var(--xyb-green-light); }
      .xybChip[aria-pressed='true'] { background:var(--xyb-green); border-color:var(--xyb-green); color:var(--xyb-on-accent); }
      .xybCards { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:12px; }
      .xybCard { border:1px solid var(--xyb-line); border-radius:var(--xyb-r-card); background:var(--xyb-surface);
                 padding:14px 16px; text-align:left; min-width:0; }
      .xybCardHead { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .xybCardVal { font-size:22px; font-weight:650; font-variant-numeric:tabular-nums; margin:6px 0 2px; }
      .xybCardSub { font-size:12px; color:var(--xyb-muted); font-variant-numeric:tabular-nums; line-height:1.6; }
      .xybSpark { width:100%; height:44px; margin-top:8px; color:var(--xyb-dash); }
      .xybSpark.good { color:var(--xyb-good); }
      .xybSpark.watch { color:var(--xyb-watch); }
      .xybSpark.alert { color:var(--xyb-alert); }
      .xybSpark.neutral { color:var(--xyb-muted); }
      .xybReviewRow { display:flex; align-items:center; gap:10px; padding:12px 14px; border:1px solid var(--xyb-line);
                      border-radius:var(--xyb-r-control); background:var(--xyb-surface); margin-bottom:8px; }
      .xybReviewMain { flex:1; min-width:0; }
      .xybNotice { margin:10px 0; padding:10px 12px; border-radius:var(--xyb-r-control);
                   background:var(--xyb-good-bg); border:1px solid var(--xyb-good-line); color:var(--xyb-good); font-size:13px; }
      .xybGrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px 12px; }
      .xybField { display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--xyb-muted); }
      .xybFieldLabel { font-size:12px; }
      .xybField input, .xybField select, .xybField textarea { border:1px solid var(--xyb-line);
        border-radius:var(--xyb-r-control); background:var(--xyb-surface); color:var(--xyb-ink);
        font:inherit; font-size:13px; padding:8px 10px; min-height:38px; width:100%; box-sizing:border-box; }
      .xybField textarea { min-height:72px; resize:vertical; }
      .xybTagRow { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px; }
      .xybControls { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin:10px 0 16px; }
      .xybControl { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--xyb-muted); }
      .xybControl input[type='number'] { width:88px; }
      .xybCheck { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--xyb-ink); }
      .xybMedRow { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
      .xybMedLabel { width:190px; flex:none; font-size:12.5px; font-variant-numeric:tabular-nums; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap; }
      .xybMedTrack { position:relative; flex:1; min-width:0; height:18px; background:var(--xyb-wash);
                     border:1px solid var(--xyb-line); border-radius:var(--xyb-r-pill); overflow:hidden; }
      .xybMedBar { position:absolute; top:0; bottom:0; background:var(--xyb-green-light); border-right:1px solid var(--xyb-green); }
      .xybCrisis { margin:12px 0 16px; padding:14px 16px; border:1px solid var(--xyb-alert-line);
                   border-radius:var(--xyb-r-card); background:var(--xyb-alert-bg); }
      .xybCrisis strong { display:block; color:var(--xyb-alert); font-size:15px; margin-bottom:6px; }
      .xybCrisis p { margin:0 0 8px; font-size:13px; line-height:var(--xyb-lh-body); color:var(--xyb-ink); }
      .xybCrisis ul { margin:0; padding-left:18px; font-size:13px; line-height:var(--xyb-lh-body); }
      .xybCrisis a { color:var(--xyb-alert); font-weight:600; }

      /* 双品牌条（V-4：侧栏隐藏后，上游归属必须在本发行版界面内可见） */
      .xybBrandStrip { flex:none; border-bottom:1px solid var(--xyb-line); padding:12px 14px;
                       display:flex; flex-direction:column; gap:9px; background:var(--xyb-surface); }
      .xybBrandRow { display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--xyb-muted); line-height:1.45; }
      .xybBrandRow strong { color:var(--xyb-ink); font-weight:620; font-size:14.5px; }
      .xybBrandRowLogo { display:block; height:32px; width:auto; flex:none; }
      .xybBrandLockup { display:block; height:26px; width:auto; flex:none; border-radius:var(--xyb-r-control); }
      .xybBrandDivider { height:1px; background:var(--xyb-line); }
      .xybBrandRow .xybTag { font-size:11.5px; padding:2px 7px; border-radius:var(--xyb-r-pill); background:var(--xyb-plum-bg);
                             color:var(--xyb-plum); border:1px solid var(--xyb-plum-line); }
      .xybBrandNote { font-size:11.5px; color:var(--xyb-faint); line-height:1.6; margin:0; }
      /* 设置页「关于」：品牌正式署名位（社区开发者要求的可见度） */
      .xybAboutRow { display:flex; align-items:center; gap:20px; flex-wrap:wrap; margin-bottom:10px; }
      .xybAboutLogoXYB { display:block; height:60px; width:auto; }
      .xybAboutLogoDSH { display:block; height:36px; width:auto; border-radius:var(--xyb-r-control); }
      .xybAboutMeta { font-size:12.5px; color:var(--xyb-muted); line-height:1.8; }
      .xybAboutMeta strong { color:var(--xyb-ink); }
      .xybAboutMeta code { font-family:var(--xyb-font-sans); font-size:12px; padding:1px 5px;
                           border-radius:4px; background:var(--xyb-wash); color:var(--xyb-ink); }
      /* 首次设置向导：覆盖在内容之上，四步走完或直接跳过 */
      .xybWizardOverlay { position:absolute; inset:0; z-index:20; background:var(--xyb-surface);
                          display:flex; align-items:center; justify-content:center; padding:24px; overflow:auto; }
      .xybWizardCard { width:100%; max-width:640px; border:1px solid var(--xyb-line); border-radius:var(--xyb-r-card);
                       background:var(--xyb-surface); padding:28px 30px; box-shadow:0 1px 0 var(--xyb-line); }
      .xybWizardSteps { display:flex; gap:8px; align-items:center; margin-bottom:18px; }
      .xybWizardStep { font-size:12px; color:var(--xyb-faint); }
      .xybWizardStep[data-on="true"] { color:var(--xyb-green-dark); font-weight:640; }
      .xybWizardTitle { margin:0 0 10px; font-family:var(--xyb-font-serif); font-size:20px; font-weight:640; }
      .xybWizardText { margin:0 0 12px; font-size:13.5px; line-height:1.75; color:var(--xyb-ink); }
      .xybWizardActions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:20px; }
      .xybWizardResult { margin-top:12px; padding:10px 12px; font-size:12.5px; line-height:1.6;
                         border-radius:var(--xyb-r-control); border:1px solid var(--xyb-line); background:var(--xyb-wash); }
      .xybWizardResult[data-ok="true"] { background:var(--xyb-good-bg); border-color:var(--xyb-good-line); color:var(--xyb-good); }
      .xybWizardResult[data-ok="false"] { background:var(--xyb-alert-bg); border-color:var(--xyb-alert-line); color:var(--xyb-alert); }
      .xybWizardInput { font:inherit; font-size:14px; padding:9px 12px; width:100%; box-sizing:border-box;
                        border:1px solid var(--xyb-line); border-radius:var(--xyb-r-control); background:var(--xyb-surface); color:inherit; }
      .xybEventFilters { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
      .xybEventFilters button { font:inherit; font-size:12px; padding:5px 10px; cursor:pointer;
                                border:1px solid var(--xyb-line); background:var(--xyb-surface); color:var(--xyb-muted);
                                border-radius:var(--xyb-r-control); }
      .xybEventFilters button[aria-pressed="true"] { background:var(--xyb-green); color:var(--xyb-on-accent); border-color:var(--xyb-green); font-weight:600; }
      .xybEvents { display:flex; flex-direction:column; gap:0; border:1px solid var(--xyb-line); border-radius:var(--xyb-r-control);
                   max-height:300px; overflow:auto; background:var(--xyb-surface); }
      .xybEventRow { display:flex; align-items:flex-start; gap:10px; padding:9px 12px; font-size:12.5px;
                     border-bottom:1px solid var(--xyb-line); line-height:1.55; }
      .xybEventRow:last-child { border-bottom:0; }
      .xybEventTime { flex:none; color:var(--xyb-faint); font-variant-numeric:tabular-nums; }
      .xybEventLevel { flex:none; padding:1px 7px; border-radius:var(--xyb-r-pill); font-size:11px; font-weight:600;
                       border:1px solid var(--xyb-line); }
      .xybEventLevel[data-level="error"] { color:var(--xyb-alert); background:var(--xyb-alert-bg); border-color:var(--xyb-alert-line); }
      .xybEventLevel[data-level="warn"] { color:var(--xyb-watch); background:var(--xyb-watch-bg); border-color:var(--xyb-watch-line); }
      .xybEventLevel[data-level="info"] { color:var(--xyb-muted); background:var(--xyb-wash); }
      .xybEventBody { flex:1; min-width:0; }
      .xybEventMeta { color:var(--xyb-faint); font-size:11.5px; }
      .xybEventEmpty { padding:18px 12px; color:var(--xyb-muted); font-size:13px; text-align:center; }
      .xybNotice { padding:10px 12px; margin-bottom:10px; font-size:12.5px; line-height:1.6; border-radius:var(--xyb-r-control);
                   background:var(--xyb-good-bg); border:1px solid var(--xyb-good-line); color:var(--xyb-good); }
      .xybDiagRow { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:12px; }
      .xybDiagInfo { font-size:12px; color:var(--xyb-muted); line-height:1.6; word-break:break-all; }

      /* 设置页（M11-1 最小可用版；M11-8 增补 1:1 细节） */
      /* 设置页宽度（实测修正）：原先写死 max-width:720px，在宽窗口下右侧空一大片。
         栅格自适应：窄窗单列不挤压，宽窗多列铺满，行宽仍受 minmax 控制。 */
      .xybSettings { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); gap:0 18px; }
      .xybSettings > .xybDisclaimer { grid-column:1/-1; }
      .xybSetBlock { border:1px solid var(--xyb-line); border-radius:var(--xyb-r-card);
                     background:var(--xyb-surface); padding:var(--xyb-s4) var(--xyb-s5); margin-bottom:var(--xyb-s4); }
      .xybSetRow { display:flex; align-items:center; justify-content:space-between; gap:var(--xyb-s4);
                   padding:var(--xyb-s3) 0; border-top:1px solid var(--xyb-line); }
      .xybSetRow:first-of-type { border-top:none; }
      .xybSetLabel { font-size:13.5px; font-weight:560; }
      .xybSetDesc { display:block; font-size:12px; color:var(--xyb-muted); margin-top:2px; line-height:1.6; }
      .xybHint { font-size:12px; line-height:var(--xyb-lh-body); color:var(--xyb-muted); }

      /* ── 设置页：模型 API Key 与青囊凭据（实测缺口：用户看不到也输不了）
         两处都是「状态行 + 输入行」结构：状态行说清配没配、来自哪一层；
         输入行只写不读 —— 已保存的值永远不会回显在界面上。 */
      .xybKeyMeta { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                     font-size:11.5px; color:var(--xyb-muted); }
      .xybKeyState { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--xyb-muted); }
      .xybKeyState[data-on='true'] { color:var(--xyb-good); }
      .xybKeyRow { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
                   padding:8px 0; border-top:1px dashed var(--xyb-line); }
      .xybKeyInput { flex:1 1 220px; min-width:170px; height:34px; min-height:34px; padding:0 10px;
                     border:1px solid var(--xyb-line); border-radius:var(--xyb-r-control);
                     background:var(--xyb-surface); color:var(--xyb-ink); font:inherit; font-size:13px; }
      .xybKeyInput:focus { outline:2px solid var(--xyb-green-light); outline-offset:1px; }
      .xybChipList { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .xybChipItem { font-size:11.5px; padding:3px 9px; border-radius:var(--xyb-r-pill);
                     background:var(--xyb-wash); border:1px solid var(--xyb-line); color:var(--xyb-ink); }
      .xybSubTitle { display:block; font-size:12.5px; font-weight:600; margin:12px 0 2px; }
    `

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ─────────────────────────────── 后端调用
    async function api(path, options) {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options
      })
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        throw new Error('服务返回了无法解析的内容')
      }
      if (!res.ok) {
        const message = data && data.message ? data.message : `请求失败（${res.status}）`
        const error = new Error(message)
        error.code = data && data.error ? data.error : 'HTTP_ERROR'
        throw error
      }
      return data
    }

    const LV_LABEL = { good: '良好', watch: '需关注', alert: '异常', unk: '未评估' }
    const DIM_ORDER = ['fitness', 'treatment', 'match', 'nutrition', 'psych', 'comorbidity', 'toxicity']
    const DIM_LABEL = {
      fitness: '基本体能',
      treatment: '治疗情况',
      match: '可匹配临床',
      nutrition: '营养',
      psych: '心理',
      comorbidity: '并发症',
      toxicity: '毒性'
    }
    /** 维度 → 页签（与服务端 DIMENSION_PAGE 一致；卡片「查看详情」跳转） */
    const DIM_PAGE = {
      fitness: 'records',
      treatment: 'records',
      match: 'match',
      nutrition: 'nutrition',
      psych: 'psych',
      comorbidity: 'care',
      toxicity: 'care'
    }

    // ─────────────────────────── 首屏（无患者档案）
    /**
     * 无数据时的看板骨架。
     *
     * 新用户打开就能看到面板结构与「未上传」标注——没有数据就写没有数据，
     * 不用空白页或 0 冒充（数据可信原则：未上传 ≠ 数值为 0）。
     */
    function EmptyBoard() {
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'xybVerdict unk' },
          h('strong', null, '尚无资料'),
          h('span', null, '资料完整度 0/7')
        ),
        DIM_ORDER.map((key) =>
          h(
            'div',
            { key, className: 'xybRow', role: 'listitem' },
            h('i', { className: 'xybDot unk', 'aria-hidden': 'true' }),
            h('span', { className: 'xybName' }, DIM_LABEL[key]),
            h('span', { className: 'xybVal' }, '未上传'),
            h('span', { className: 'xybLv unk' }, '未上传')
          )
        ),
        h('p', { className: 'xybNote' }, '还没有上传任何资料。导入病历、化验单或检查报告后，这里会按七个维度更新；未上传的项不会显示为 0。'),
        h(
          'div',
          { className: 'xybDisclaimer' },
          '以上为指标数值与记录情况的呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。'
        )
      )
    }

    function FirstRun({ onCreate, busy, error }) {
      const [name, setName] = React.useState('')
      return h(
        'div',
        { className: 'xybEmpty' },
        h('strong', null, '还没有患者档案'),
        h('p', null, `${PRODUCT}需要先建立一份患者档案，之后导入的病历、指标、用药记录都会归到这份档案下。`),
        h('p', null, '数据全部保存在你自己的电脑上，不会上传。'),
        error ? h('div', { className: 'xybError', style: { marginTop: 16, textAlign: 'left' } }, error) : null,
        h(
          'div',
          { className: 'xybForm' },
          h('input', {
            value: name,
            onChange: (e) => setName(e.target.value),
            placeholder: '患者姓名或化名',
            'aria-label': '患者姓名或化名',
            maxLength: 40
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'xybBtn xybBtn--primary',
              disabled: busy || !name.trim(),
              onClick: () => onCreate(name.trim())
            },
            busy ? '正在建立…' : '建立档案'
          )
        ),
        h('div', { style: { marginTop: 18, textAlign: 'left' } }, h(EmptyBoard))
      )
    }

    // ─────────────────────────────── 看板
    function Board({ patient, onChanged, onNavigate }) {
      const [state, setState] = React.useState({ status: 'loading', board: null, error: null })
      const [open, setOpen] = React.useState(null)

      const load = React.useCallback(() => {
        setState({ status: 'loading', board: null, error: null })
        // 参数走查询串（宿主的 exact 路由只接受字面路径，`/patients/:id` 这类
        // 路径参数不被接受 —— 宿主源码 ENDPOINT_SEGMENT_PATTERN 不含冒号）
        api(`/patient/board?id=${encodeURIComponent(patient.id)}`)
          .then((board) => setState({ status: 'ready', board, error: null }))
          .catch((error) => setState({ status: 'error', board: null, error: error.message }))
      }, [patient.id])

      React.useEffect(load, [load])

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取…')
      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h(
            'button',
            { type: 'button', className: 'xybRow', style: { marginTop: 12 }, onClick: load },
            '重试'
          )
        )
      }

      const board = state.board
      // 全空数据（新用户 / 还没上传任何资料）时把「未评估」显示为「未上传」：
      // 这是对用户而言更准确的事实陈述，也与「未上传不会显示为 0」一致。
      const noData = Number(board.completeness && board.completeness.have) === 0
      const label = (dim) => (dim.lv === 'unk' && noData ? '未上传' : null)
      const go = (page) => {
        if (typeof onNavigate === 'function' && page) onNavigate(page)
      }
      const watch = board.watch || []
      const careDigest = board.careDigest || []

      const rows = DIM_ORDER.map((key) => {
        const dim = board.dimensions[key] || { lv: 'unk', value: '未上传', note: '' }
        const isOpen = open === key
        return h(
          'div',
          { key },
          h(
            'button',
            {
              type: 'button',
              className: 'xybRow',
              'aria-expanded': isOpen,
              onClick: () => setOpen(isOpen ? null : key)
            },
            h('i', { className: `xybDot ${dim.lv}`, 'aria-hidden': 'true' }),
            h('span', { className: 'xybName' }, DIM_LABEL[key]),
            h('span', { className: 'xybVal' }, label(dim) || dim.value),
            h(
              'span',
              { className: `xybLv ${dim.lv}` },
              label(dim) || LV_LABEL[dim.lv] || dim.lv
            )
          ),
          isOpen
            ? h(
                'div',
                { className: 'xybNote' },
                h('p', { style: { margin: '0 0 8px' } }, dim.note || '暂无说明'),
                h(
                  'button',
                  { type: 'button', className: 'xybBtn xybBtn--ghost', style: { minHeight: 32 }, onClick: () => go(DIM_PAGE[key]) },
                  '查看详情'
                )
              )
            : null
        )
      })

      return h(
        'div',
        null,
        h(
          'div',
          { className: `xybVerdict ${board.verdict.lv}` },
          h('strong', null, board.verdict.text),
          h('span', null, `资料完整度 ${board.completeness.have}/${board.completeness.total}`)
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h2', { className: 'xybSecTitle' }, '需关注项'),
          watch.length > 0
            ? watch.map((item) =>
                h(
                  'div',
                  { key: item.key, className: 'xybRow', role: 'listitem' },
                  h('i', { className: `xybDot ${item.lv}`, 'aria-hidden': 'true' }),
                  h('span', { className: 'xybName' }, item.label),
                  h(
                    'span',
                    { className: 'xybWatchMain' },
                    h('span', { className: 'xybVal' }, item.value),
                    h('span', { className: 'xybSetDesc' }, item.note)
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'xybBtn xybBtn--ghost', style: { minHeight: 32 }, onClick: () => go(item.page) },
                    '查看详情'
                  )
                )
              )
            : h('p', { className: 'xybHint' }, '当前没有需关注项。这不代表病情稳定。')
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h2', { className: 'xybSecTitle' }, '维度状态'),
          h('p', { className: 'xybTabsLine' }, '7 个维度 · 点击展开依据'),
          rows
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h2', { className: 'xybSecTitle' }, '全程管理'),
          h('p', { className: 'xybTabsLine' }, '贯穿治疗过程的四类管理'),
          careDigest.map((item) =>
            h(
              'div',
              { key: item.key, className: 'xybSetRow', role: 'listitem' },
              h('span', null, h('span', { className: 'xybSetLabel' }, item.label), h('span', { className: 'xybSetDesc' }, item.detail)),
              h('span', { className: `xybLv ${item.lv}` }, LV_LABEL[item.lv] || item.lv)
            )
          )
        ),
        h(
          'div',
          { className: 'xybMeta' },
          h('span', null, `患者：${patient.name}`),
          h(
            'button',
            {
              type: 'button',
              className: 'xybBtn xybBtn--ghost',
              style: { minHeight: 32, padding: '0 10px' },
              onClick: load
            },
            '刷新'
          )
        ),
        h(
          'div',
          { className: 'xybDisclaimer' },
          '以上为指标数值与记录情况的呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。'
        )
      )
    }

    // ─────────────────────────────── 病情整理
    const RECORD_VIEWS = [
      { key: 'library', label: '资料库' },
      { key: 'review', label: '报告核对' },
      { key: 'trends', label: '指标趋势' },
      { key: 'assess', label: '病情评估' },
      { key: 'summary', label: '病情汇总' }
    ]
    const CATEGORY_LABEL = {
      tumor: '肿瘤标志物',
      cbc: '血常规',
      liver: '肝功能',
      kidney: '肾功能',
      infection: '感染',
      metabolic: '代谢',
      other: '其他'
    }
    const DELTA_LABEL = { up: '上升', down: '下降', flat: '持平', unknown: '单次记录' }
    const MAX_COMPARE = 8

    const fmtNumber = (value) => {
      if (value === null || value === undefined || value === '') return '—'
      const n = Number(value)
      if (!Number.isFinite(n)) return String(value)
      return String(Number.isInteger(n) ? n : Math.round(n * 100) / 100)
    }
    const fmtRange = (item) => {
      if (item.refLow === null && item.refHigh === null) return '无参考范围'
      if (item.refLow === null) return `≤ ${fmtNumber(item.refHigh)}`
      if (item.refHigh === null) return `≥ ${fmtNumber(item.refLow)}`
      return `${fmtNumber(item.refLow)}–${fmtNumber(item.refHigh)}`
    }

    /** 迷你趋势（内联 SVG；颜色由服务端方向语义 tone 决定，不在前端判定） */
    function Spark({ points, tone, label }) {
      const values = (points || []).map((p) => Number(p.value)).filter((v) => Number.isFinite(v))
      if (values.length < 2) return null
      const min = Math.min(...values)
      const max = Math.max(...values)
      const span = max - min || 1
      const step = 100 / (values.length - 1)
      const d = values
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(30 - ((v - min) / span) * 26).toFixed(2)}`)
        .join(' ')
      return h(
        'svg',
        {
          className: `xybSpark ${tone || 'neutral'}`,
          viewBox: '0 0 100 32',
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': label || `最近 ${values.length} 次记录趋势`
        },
        h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 2, vectorEffect: 'non-scaling-stroke' })
      )
    }

    /** 指标趋势（真数据：/patient/indicator-summary + 多指标对比） */
    function RecordsTrends({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', items: [], categories: [], error: null })
      const [cats, setCats] = React.useState([])
      const [compare, setCompare] = React.useState([])

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/indicator-summary?id=${encodeURIComponent(patient.id)}`)
          .then((data) => setState({ status: 'ready', items: data.items || [], categories: data.categories || [], error: null }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])

      React.useEffect(load, [load])

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取指标…')
      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试')
        )
      }

      const toggleCat = (cat) =>
        setCats((list) => (list.includes(cat) ? list.filter((c) => c !== cat) : [...list, cat]))
      const toggleCompare = (id) =>
        setCompare((list) => {
          if (list.includes(id)) return list.filter((x) => x !== id)
          if (list.length >= MAX_COMPARE) return list
          return [...list, id]
        })

      const visible = cats.length ? state.items.filter((item) => cats.includes(item.category)) : state.items
      const compared = state.items.filter((item) => compare.includes(item.id))

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '指标趋势'),
        h('p', { className: 'xybTabsLine' }, `共 ${state.items.length} 项已有数据 · 多指标对比上限 ${MAX_COMPARE} 个`),
        h(
          'div',
          { className: 'xybChips' },
          state.categories.map((cat) =>
            h(
              'button',
              {
                key: cat,
                type: 'button',
                className: 'xybChip',
                'aria-pressed': cats.includes(cat),
                onClick: () => toggleCat(cat)
              },
              CATEGORY_LABEL[cat] || cat
            )
          )
        ),
        visible.length === 0
          ? h(
              'div',
              { className: 'xybEmpty' },
              h('strong', null, '还没有可展示的指标'),
              h('p', null, '只有已确认的记录会进入趋势。请先在「报告核对」里确认，或到「看板」建立档案后手工录入。')
            )
          : h(
              'div',
              { className: 'xybCards' },
              visible.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'xybCard' },
                  h(
                    'div',
                    { className: 'xybCardHead' },
                    h('span', { className: 'xybName' }, item.name),
                    h('span', { className: `xybLv ${item.tone === 'neutral' ? 'unk' : item.tone}` }, LV_LABEL[item.tone] || '待定')
                  ),
                  h('div', { className: 'xybCardVal' }, `${fmtNumber(item.latest.value)}${item.unit ? ` ${item.unit}` : ''}`),
                  h(
                    'div',
                    { className: 'xybCardSub' },
                    `参考 ${fmtRange(item)} · ${item.latest.at} · 最近变化${DELTA_LABEL[item.delta] || item.delta}`
                  ),
                  h(Spark, { points: item.points, tone: item.tone }),
                  h(
                    'div',
                    { style: { marginTop: 8 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'xybBtn xybBtn--ghost',
                        style: { minHeight: 30 },
                        'aria-pressed': compare.includes(item.id),
                        onClick: () => toggleCompare(item.id)
                      },
                      compare.includes(item.id) ? '移出对比' : '加入对比'
                    )
                  )
                )
              )
            ),
        compared.length > 0
          ? h(
              'section',
              { className: 'xybSec', style: { marginTop: 18 } },
              h('h3', { className: 'xybSecTitle' }, `多指标对比（${compared.length}/${MAX_COMPARE}）`),
              h('p', { className: 'xybTabsLine' }, '共享时间轴 · 各图独立纵轴'),
              compared.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'xybCard', style: { marginBottom: 8 } },
                  h(
                    'div',
                    { className: 'xybCardHead' },
                    h('span', { className: 'xybName' }, item.name),
                    h('span', { className: `xybLv ${item.tone === 'neutral' ? 'unk' : item.tone}` }, LV_LABEL[item.tone] || '待定')
                  ),
                  h('div', { className: 'xybCardSub' }, `${fmtNumber(item.latest.value)}${item.unit ? ` ${item.unit}` : ''} · ${item.latest.at}`),
                  h(Spark, { points: item.points, tone: item.tone })
                )
              )
            )
          : null,
        h(
          'div',
          { className: 'xybDisclaimer' },
          '以上为指标数值与记录情况的呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。'
        )
      )
    }

    /** 报告核对（真数据：/patient/pending + /patient/review；就地结清） */
    function RecordsReview({ patient, onChanged }) {
      const [state, setState] = React.useState({ status: 'loading', pending: [], doubted: [], error: null, busy: null, notice: null })

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/pending?id=${encodeURIComponent(patient.id)}`)
          .then((data) =>
            setState((s) => ({
              ...s,
              status: 'ready',
              pending: data.items || [],
              doubted: data.doubted || [],
              error: null,
              busy: null
            }))
          )
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])

      React.useEffect(load, [load])

      const act = (action, record) => {
        setState((s) => ({ ...s, busy: record.id, error: null, notice: null }))
        api(`/patient/review?id=${encodeURIComponent(patient.id)}`, { method: 'POST', body: JSON.stringify({ action, recordId: record.id }) })
          .then(() => {
            setState((s) => ({ ...s, busy: null, notice: action === 'confirm' ? '已确认，这条记录已进入趋势。' : '已标为存疑，可在下方继续处理。' }))
            load()
            if (typeof onChanged === 'function') onChanged()
          })
          .catch((error) => setState((s) => ({ ...s, busy: null, error: error.message })))
      }

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取待核对项…')

      const line = (record, doubted) =>
        h(
          'div',
          { key: record.id, className: 'xybReviewRow' },
          h('i', { className: `xybDot ${doubted ? 'unk' : 'watch'}`, 'aria-hidden': 'true' }),
          h(
            'div',
            { className: 'xybReviewMain' },
            h(
              'div',
              null,
              h('span', { className: 'xybName' }, record.source?.rawText || record.indicator),
              h('span', { className: 'xybVal', style: { marginLeft: 8 } }, `${fmtNumber(record.value)}${record.unit ? ` ${record.unit}` : ''}`)
            ),
            h(
              'div',
              { className: 'xybCardSub' },
              `${record.measuredAt || '日期未知'} · ${record.source?.kind === 'manual' ? '手工录入' : '机器抽取'}` +
                (record.source?.pageNo ? ` · 第 ${record.source.pageNo} 页` : '')
            )
          ),
          doubted
            ? h('span', { className: 'xybLv unk' }, '已存疑')
            : h(
                'button',
                {
                  type: 'button',
                  className: 'xybBtn xybBtn--primary',
                  style: { minHeight: 32 },
                  disabled: state.busy === record.id,
                  onClick: () => act('confirm', record)
                },
                '确认'
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'xybBtn',
              style: { minHeight: 32 },
              disabled: state.busy === record.id || doubted,
              onClick: () => act('doubt', record)
            },
            '存疑'
          )
        )

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '报告核对'),
        h('p', { className: 'xybTabsLine' }, '未核对的记录不会进入趋势/看板 —— 确认或存疑，逐条结清。'),
        state.notice ? h('div', { className: 'xybNotice' }, state.notice) : null,
        state.error ? h('div', { className: 'xybError', style: { margin: '10px 0' } }, state.error) : null,
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, `待确认（${state.pending.length}）`),
          state.pending.length === 0
            ? h('p', { className: 'xybHint' }, '没有待确认项。')
            : state.pending.map((record) => line(record, false))
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, `已存疑（${state.doubted.length}）`),
          state.doubted.length === 0
            ? h('p', { className: 'xybHint' }, '没有存疑项。')
            : state.doubted.map((record) => line(record, true)),
          h('p', { className: 'xybHint' }, '存疑项保留在清单里，不会被静默丢弃；重新判断前不会进入任何计算。')
        )
      )
    }

    /** 病情汇总（真数据派生：看板 + 关键指标 + 待办） */
    function RecordsSummary({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', board: null, items: [], pending: 0, error: null })

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        Promise.all([
          api(`/patient/board?id=${encodeURIComponent(patient.id)}`),
          api(`/patient/indicator-summary?id=${encodeURIComponent(patient.id)}`),
          api(`/patient/pending?id=${encodeURIComponent(patient.id)}`)
        ])
          .then(([board, summary, pending]) =>
            setState({
              status: 'ready',
              board,
              items: summary.items || [],
              pending: (pending.items || []).length + (pending.doubted || []).length,
              error: null
            })
          )
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])

      React.useEffect(load, [load])

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在汇总…')
      if (state.status === 'error') {
        return h('div', null, h('div', { className: 'xybError' }, state.error), h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试'))
      }

      const board = state.board
      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '病情汇总'),
        h('div', { className: `xybVerdict ${board.verdict.lv}` }, h('strong', null, board.verdict.text),
          h('span', null, `${patient.name} · 资料完整度 ${board.completeness.have}/${board.completeness.total}`)),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '维度一览'),
          DIM_ORDER.map((key) =>
            h(
              'div',
              { key, className: 'xybSetRow', role: 'listitem' },
              h('span', null, h('span', { className: 'xybSetLabel' }, DIM_LABEL[key]),
                h('span', { className: 'xybSetDesc' }, board.dimensions[key].note || '暂无说明')),
              h('span', { className: `xybLv ${board.dimensions[key].lv}` }, LV_LABEL[board.dimensions[key].lv] || board.dimensions[key].lv)
            )
          )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '关键指标'),
          state.items.length === 0
            ? h('p', { className: 'xybHint' }, '还没有已确认的指标记录。')
            : state.items.slice(0, 6).map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'xybSetRow', role: 'listitem' },
                  h('span', null, h('span', { className: 'xybSetLabel' }, item.name),
                    h('span', { className: 'xybSetDesc' }, `参考 ${fmtRange(item)} · ${item.latest.at}`)),
                  h('span', { className: 'xybVal', style: { flex: 'initial' } }, `${fmtNumber(item.latest.value)}${item.unit ? ` ${item.unit}` : ''}`)
                )
              )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '准备问医生的问题'),
          h('p', { className: 'xybHint' }, state.pending > 0 ? `有 ${state.pending} 条未结清记录，建议先核对完再问（避免基于未确认数据提问）。` : '资料已结清，可带去复诊。'),
          h('p', { className: 'xybHint' }, '问题清单的逐条编辑尚未提供；当前版本先把依据备齐。')
        ),
        h('div', { className: 'xybDisclaimer' }, '以上为指标数值与记录情况的呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。')
      )
    }

    /** 资料库（文档导入在 后续；当前如实展示手工录入记录） */
    function RecordsLibrary({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', items: [], error: null })
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/records?id=${encodeURIComponent(patient.id)}`)
          .then((data) => setState({ status: 'ready', items: data.items || [], error: null }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])
      React.useEffect(load, [load])

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取资料…')
      const manual = state.items.filter((r) => r.source?.kind === 'manual')
      const fromDocs = state.items.filter((r) => r.source?.kind !== 'manual')

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '资料库'),
        h(
          'div',
          { className: 'xybTodo' },
          h('strong', null, '文档导入尚未实现'),
          h('p', null, '拍照 / PDF 导入与本地解析尚未提供；当前记录来自手工录入与核对确认。'),
          h('p', { className: 'xybTodoNote' }, '这里先不列出虚假的文档条目。')
        ),
        h(
          'section',
          { className: 'xybSec', style: { marginTop: 16 } },
          h('h3', { className: 'xybSecTitle' }, `已确认记录（${state.items.length}）`),
          h('p', { className: 'xybTabsLine' }, `手工录入 ${manual.length} 条 · 来自文档核对 ${fromDocs.length} 条`),
          state.items.slice(-8).reverse().map((record) =>
            h(
              'div',
              { key: record.id, className: 'xybSetRow', role: 'listitem' },
              h('span', null, h('span', { className: 'xybSetLabel' }, record.indicator),
                h('span', { className: 'xybSetDesc' }, `${record.measuredAt || '日期未知'} · ${record.source?.kind === 'manual' ? '手工录入' : '文档核对'}`)),
              h('span', { className: 'xybVal', style: { flex: 'initial' } }, `${fmtNumber(record.value)}${record.unit ? ` ${record.unit}` : ''}`)
            )
          )
        )
      )
    }

    /** 病情评估（真数据：/patient/assess；与临床匹配共用一份档案） */
    const ASSESS_SEX_LABEL = { male: '男', female: '女' }

    function Field({ label, children }) {
      return h('label', { className: 'xybField' }, h('span', { className: 'xybFieldLabel' }, label), children)
    }

    function RecordsAssess({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', error: null, notice: null, saving: false })
      const [draft, setDraft] = React.useState(null)

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/assess?id=${encodeURIComponent(patient.id)}`)
          .then((profile) => {
            setDraft(profile)
            setState({ status: 'ready', error: null, notice: null, saving: false })
          })
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])

      React.useEffect(load, [load])

      if (state.status === 'loading' || !draft) return h('div', { className: 'xybLoading' }, '正在读取评估档案…')
      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试')
        )
      }

      const setGroup = (group, key, value) =>
        setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: value } }))
      const setTextTags = (group, key, raw) =>
        setGroup(group, key, raw.split(/[，,、\n]/).map((s) => s.trim()).filter(Boolean))
      const setPending = (raw) =>
        setDraft((d) => ({ ...d, pending: raw.split(/[，,、\n]/).map((s) => s.trim()).filter(Boolean) }))

      const save = () => {
        setState((s) => ({ ...s, saving: true, error: null, notice: null }))
        api(`/patient/assess?id=${encodeURIComponent(patient.id)}`, {
          method: 'POST',
          body: JSON.stringify({
            basic: draft.basic,
            diagnosis: draft.diagnosis,
            treatment: draft.treatment,
            keyIndicators: draft.keyIndicators,
            pending: draft.pending
          })
        })
          .then((profile) => {
            setDraft(profile)
            setState((s) => ({ ...s, saving: false, notice: '已保存。' }))
          })
          .catch((error) => setState((s) => ({ ...s, saving: false, error: error.message })))
      }

      const numField = (group, key, label) =>
        h(
          Field,
          { label },
          h('input', {
            type: 'number',
            inputMode: 'numeric',
            'aria-label': label,
            value: draft[group][key] ?? '',
            onChange: (e) => setGroup(group, key, e.target.value)
          })
        )
      const textField = (group, key, label, options = {}) =>
        h(
          Field,
          { label },
          h('input', {
            type: 'text',
            'aria-label': label,
            maxLength: options.maxLength || 120,
            value: draft[group][key] ?? '',
            onChange: (e) => setGroup(group, key, e.target.value)
          })
        )

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '病情评估'),
        h('p', { className: 'xybTabsLine' }, '这份档案同时供临床匹配使用；未填的项保持「未填写」，不会当成 0。'),
        state.notice ? h('div', { className: 'xybNotice' }, state.notice) : null,
        state.error ? h('div', { className: 'xybError', style: { margin: '10px 0' } }, state.error) : null,
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '基本情况'),
          h(
            'div',
            { className: 'xybGrid' },
            numField('basic', 'age', '年龄'),
            h(
              Field,
              { label: '性别' },
              h(
                'select',
                { 'aria-label': '性别', value: draft.basic.sex ?? '', onChange: (e) => setGroup('basic', 'sex', e.target.value || null) },
                h('option', { value: '' }, '未填写'),
                h('option', { value: 'male' }, ASSESS_SEX_LABEL.male),
                h('option', { value: 'female' }, ASSESS_SEX_LABEL.female)
              )
            ),
            numField('basic', 'ecog', 'ECOG（0–4）'),
            numField('basic', 'weightKg', '体重（kg）'),
            numField('basic', 'heightCm', '身高（cm）'),
            textField('basic', 'note', '备注')
          )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '诊断与病理'),
          h(
            'div',
            { className: 'xybGrid' },
            textField('diagnosis', 'primary', '原发部位'),
            textField('diagnosis', 'histology', '组织学'),
            textField('diagnosis', 'stage', '分期'),
            textField('diagnosis', 'note', '备注')
          ),
          h(
            'div',
            { className: 'xybSec' },
            h(Field, { label: '基因（分子特征，逗号分隔）' }, h('input', {
              type: 'text',
              'aria-label': '基因（分子特征）',
              value: (draft.diagnosis.gene || []).join('、'),
              onChange: (e) => setTextTags('diagnosis', 'gene', e.target.value)
            })),
            h(Field, { label: '病理 / 免疫组化（逗号分隔）' }, h('input', {
              type: 'text',
              'aria-label': '病理 / 免疫组化',
              value: (draft.diagnosis.ihc || []).join('、'),
              onChange: (e) => setTextTags('diagnosis', 'ihc', e.target.value)
            }))
          )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '治疗经过'),
          (draft.treatment.lines || []).map((line, index) =>
            h(
              'div',
              { key: index, className: 'xybGrid', style: { marginBottom: 8 } },
              h(
                Field,
                { label: `方案 ${index + 1} 名称` },
                h('input', {
                  type: 'text',
                  'aria-label': `方案 ${index + 1} 名称`,
                  value: line.name ?? '',
                  onChange: (e) => {
                    const lines = [...draft.treatment.lines]
                    lines[index] = { ...lines[index], name: e.target.value }
                    setGroup('treatment', 'lines', lines)
                  }
                })
              ),
              h(
                Field,
                { label: '开始日期' },
                h('input', {
                  type: 'text',
                  placeholder: 'YYYY-MM-DD',
                  'aria-label': `方案 ${index + 1} 开始日期`,
                  value: line.startedAt ?? '',
                  onChange: (e) => {
                    const lines = [...draft.treatment.lines]
                    lines[index] = { ...lines[index], startedAt: e.target.value }
                    setGroup('treatment', 'lines', lines)
                  }
                })
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'xybBtn xybBtn--ghost',
                  style: { minHeight: 38 },
                  onClick: () => setGroup('treatment', 'lines', draft.treatment.lines.filter((_, i) => i !== index))
                },
                '删除这条'
              )
            )
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'xybBtn',
              onClick: () =>
                setGroup('treatment', 'lines', [
                  ...(draft.treatment.lines || []),
                  { line: String((draft.treatment.lines || []).length + 1), name: '', startedAt: '', endedAt: '', note: '' }
                ])
            },
            '添加方案'
          ),
          h(Field, { label: '治疗经过备注' }, h('textarea', {
            'aria-label': '治疗经过备注',
            value: draft.treatment.note ?? '',
            onChange: (e) => setGroup('treatment', 'note', e.target.value)
          }))
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '当前关键指标'),
          h(Field, { label: '备注（指标数值请在「报告核对」确认或「指标趋势」中录入）' }, h('textarea', {
            'aria-label': '当前关键指标备注',
            value: draft.keyIndicators.note ?? '',
            onChange: (e) => setGroup('keyIndicators', 'note', e.target.value)
          }))
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '待补充项'),
          h(Field, { label: '还没拿到的资料（逗号分隔）' }, h('input', {
            type: 'text',
            'aria-label': '待补充项',
            value: (draft.pending || []).join('、'),
            onChange: (e) => setPending(e.target.value)
          }))
        ),
        h(
          'div',
          null,
          h(
            'button',
            { type: 'button', className: 'xybBtn xybBtn--primary', disabled: state.saving, onClick: save },
            state.saving ? '正在保存…' : '保存评估档案'
          )
        ),
        h('div', { className: 'xybDisclaimer' }, '以上为档案信息的录入与呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。')
      )
    }

    /** 病情整理主容器：五个子页（资料库 / 报告核对 / 指标趋势 / 病情评估 / 病情汇总） */
    function PageRecords({ patient, onChanged }) {
      const [view, setView] = React.useState('trends')
      return h(
        'div',
        null,
        h(
          'nav',
          { className: 'xybChips', role: 'tablist', 'aria-label': '病情整理子页' },
          RECORD_VIEWS.map((entry) =>
            h(
              'button',
              {
                key: entry.key,
                type: 'button',
                role: 'tab',
                className: 'xybChip',
                'aria-selected': view === entry.key,
                'aria-pressed': view === entry.key,
                onClick: () => setView(entry.key)
              },
              entry.label
            )
          )
        ),
        view === 'trends'
          ? h(RecordsTrends, { patient })
          : view === 'review'
            ? h(RecordsReview, { patient, onChanged })
            : view === 'summary'
              ? h(RecordsSummary, { patient })
              : view === 'library'
                ? h(RecordsLibrary, { patient })
                : h(RecordsAssess, { patient })
      )
    }

    // ─────────────────────────────── 页签（对齐 docs/prototype-v2.html）
    const TABS = [
      { key: 'dash', label: '看板' },
      { key: 'records', label: '病情整理' },
      { key: 'timeline', label: '病情一图秀' },
      { key: 'match', label: '临床匹配' },
      { key: 'nutrition', label: '营养管理' },
      { key: 'psych', label: '心理支持' },
      { key: 'care', label: '全程管理' }
    ]
    const TAB_TODO = {
      records: '病历导入与逐页核对尚未提供，会在后续版本加入。',
      timeline: '指标与用药的时间轴对齐尚未提供，会在后续版本加入。',
      match: '入排标准逐条对照尚未提供；可先在「入组档案」整理个人信息。',
      nutrition: '能量蛋白与摄入记录尚未提供，会在后续版本加入。',
      psych: '量表呈现与危机热线尚未提供，会在后续版本加入。',
      care: '毒性 / 并发症 / 带管 / 血管通路尚未提供，会在后续版本加入。',
      assess: '结构化评估档案（基本情况/诊断病理/治疗经过/待补充项）尚未提供，会在后续版本加入。'
    }

    /** 未实现页签的诚实占位：不铺演示数据，并写明归属里程碑。 */
    function TabPlaceholder({ tabKey }) {
      return h(
        'div',
        { className: 'xybTodo' },
        h('strong', null, '此页尚未实现'),
        h('p', null, TAB_TODO[tabKey] || '该页在后续里程碑中实现。'),
        h(
          'p',
          { className: 'xybTodoNote' },
          '这里先不铺示意数据——宁可空白并说明，也不用演示数据冒充你的病情。'
        )
      )
    }

    /**
     * 检索通道（青囊）：复用青囊插件自己的面板。
     *
     * 为什么不在这直接 fetch /qingnang/channels：
     *   那是**青囊的路由**（它的 API_BASE = /api/xyb/qingnang）。契约测试按
     *   「插件自己的客户端 ↔ 插件自己的服务端路由表」双向对账，跨插件调用会被判
     *   「服务端没有这条路由 → 界面点下去 404，且只在控制台可见」——拦得对，
     *   正确做法是用青囊导出的视图（它调自己的接口，状态是真的）。
     *
     * 桥：青囊客户端在自己的 apply() 里把视图挂到 window.__xybQingnang。
     *   模块加载先后不可依赖 ⇒ 只在渲染时取；取不到就如实显示未载入 + 重试，不造假。
     */
    /**
     * 检索通道（青囊 MCP）—— 设置页内的真实清单。
     *
     * 为什么不再用 `window.__xybQingnang` 那个跳插件全局：
     * 它依赖「青囊客户端先于本工作台装载」这个**未定义**的顺序；顺序反过来就只剩
     * 一句「面板尚未载入」—— 用户看到的就是「配置了哪些 MCP 完全看不到」。
     * 现在直接调青囊自己的 HTTP 接口（同源、同一套路由）：顺序无关、失败可解释。
     */
    function QingnangSettingsSection() {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [drafts, setDrafts] = React.useState({})
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api('/qingnang/credentials')
          .then((data) => setState({ status: 'ready', data, error: null }))
          .catch((error) => setState({ status: 'error', data: null, error: error.message }))
      }, [])
      React.useEffect(load, [load])

      const save = (name, clear) => {
        const value = clear ? '' : String(drafts[name] || '').trim()
        if (!clear && !value) {
          setNotice('请先把这个 Key 填进输入框，再点保存')
          return
        }
        setBusy(name)
        setNotice(null)
        api('/qingnang/credentials', { method: 'POST', body: JSON.stringify({ name, value }) })
          .then((data) => {
            setDrafts((d) => ({ ...d, [name]: '' }))
            setBusy(null)
            setNotice(`${name} ${clear ? '已清除' : '已保存'}${data?.cleared ? '' : '（通道已按新凭据重建）'}`)
            load()
          })
          .catch((error) => {
            setBusy(null)
            setNotice(`保存失败：${error.message}`)
          })
      }

      const header = h('h2', { className: 'xybSecTitle' }, '检索通道（青囊 MCP）')
      if (state.status === 'loading') {
        return h('section', { className: 'xybSetBlock' }, header, h('p', { className: 'xybHint' }, '正在读取通道与凭据状态…'))
      }
      if (state.status === 'error') {
        return h(
          'section',
          { className: 'xybSetBlock' },
          header,
          h('p', { className: 'xybHint' }, `读不到青囊通道：${state.error}。青囊是独立插件，没装载时这里不会显示任何猜测值。`),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', { className: 'xybKeyState' }, '通道状态', h('span', { className: 'xybKeyMeta' }, '未知（接口不可用）')),
            h('button', { type: 'button', className: 'xybBtn', onClick: load }, '重试')
          )
        )
      }

      const data = state.data || {}
      const channels = data.channels || []
      const skills = data.skills || {}
      return h(
        'section',
        { className: 'xybSetBlock' },
        header,
        h(
          'p',
          { className: 'xybHint' },
          data.snapshotOk === false
            ? `青囊能力包未就绪（${data.snapshotReason || '未安装'}）：通道无法注册，但仍会列出「需要哪些 Key」。`
            : `共 ${channels.length} 组需要凭据的通道，已注册 ${data.registeredCount || 0} 条。Key 只写在本机；保存后立刻重建通道，不需要重启。`
        ),
        channels.length === 0
          ? h('p', { className: 'xybHint' }, '没有登记任何需要凭据的通道。')
          : channels.map((row) =>
              h(
                'div',
                { key: row.serverName, style: { marginTop: 10 } },
                h('span', { className: 'xybSubTitle' }, `${row.displayName || row.channelId}${row.statusText ? ` · ${row.statusText}` : ''}`),
                row.unknownKeys
                  ? h('p', { className: 'xybHint' }, '该通道声明需要凭据，但凭据键未登记 —— 标记为「需人工核实」，不做猜测。')
                  : row.keys.map((key) =>
                      h(
                        'div',
                        { key: key.name, className: 'xybKeyRow' },
                        h(
                          'span',
                          null,
                          h('span', { className: 'xybKeyMeta' }, key.name),
                          h(
                            'span',
                            { className: 'xybKeyState', 'data-on': key.configured ? 'true' : 'false', style: { display: 'block', marginTop: 2 } },
                            key.configured
                              ? `已配置 · 来源 ${key.source === 'env' ? '环境变量' : '本机设置'}`
                              : '未配置（该通道因此未启用）'
                          )
                        ),
                        h('input', {
                          className: 'xybKeyInput',
                          type: 'password',
                          autoComplete: 'off',
                          'aria-label': `${key.name} 的值`,
                          placeholder: key.configured ? '重新输入可覆盖（不会显示已保存的值）' : '粘贴社区发给你的 Key',
                          value: drafts[key.name] || '',
                          onChange: (e) => setDrafts((d) => ({ ...d, [key.name]: e.target.value }))
                        }),
                        h(
                          'button',
                          { type: 'button', className: 'xybBtn xybBtn--primary', disabled: busy === key.name, onClick: () => save(key.name, false) },
                          busy === key.name ? '保存中…' : '保存'
                        ),
                        key.configured
                          ? h('button', { type: 'button', className: 'xybBtn', disabled: busy === key.name, onClick: () => save(key.name, true) }, '清除')
                          : null
                      )
                    )
              )
            ),
        h('span', { className: 'xybSubTitle' }, `已装载技能（${(skills.installed || []).length}）`),
        skills.error
          ? h('p', { className: 'xybHint' }, `技能未装载（${skills.error}）`)
          : h('div', { className: 'xybChipList' }, (skills.installed || []).map((name) => h('span', { key: name, className: 'xybChipItem' }, name))),
        notice ? h('p', { className: 'xybHint', style: { marginTop: 8 } }, notice) : null
      )
    }

    /**
     * 模型与 API Key —— 只写**当前真的能配的东西**，不虚构入口。
     *  · 对话模型：在右侧「AI 协助」输入框的模型下拉里切换（宿主提供，改完即生效）。
     *  · 检索通道的凭据 Key：在上方「检索通道（青囊）」面板里填，保存到本机后即时生效。
     *  · 模型服务的 baseURL / 账号级 Key：属宿主运行时配置，本工作台**不改写**（两套真源必然漂移）。
     */
    /**
     * 模型与 API Key —— 真表单（不是一句「由宿主运行时管理」）。
     *
     * 写入的是**宿主自己的凭据存储**（与宿主设置面板同一份），本工作台不留副本，
     * 所以两处不会互相覆盖；读只回「配了没有 + 来自哪一层」，值从不回显。
     */
    /**
     * 模型与 API Key —— 下拉式「单提供方面板」+ 自定义提供方 + 「右侧 AI 栏用哪个模型」。
     *
     * 排版决策（主人明确要求）：**不要全部摊开**。默认只露一个下拉；
     * 选中哪个提供方，才展开那个提供方的地址与 Key 那一份表单。
     * 模型菜单只展示探测返回 200 的模型 —— 用不了的不出现在列表里。
     *
     * 数据真源仍是宿主：Key 写宿主凭据存储、自定义提供方写 `llm-pi-ai` 路由字典、
     * 选中的模型写宿主 agent 默认模型。本工作台不留副本。
     */
    const PROTOCOL_LABEL = {
      'openai-completions': 'OpenAI 兼容（/chat/completions）',
      'openai-responses': 'OpenAI Responses（/responses）',
      'anthropic-messages': 'Anthropic Messages（/v1/messages）'
    }
    const PROTOCOL_HINT = {
      'openai-completions': '地址要写到版本段，例如 https://api.openai.com/v1 —— 探测时会拼 /models。',
      'openai-responses': '地址要写到版本段，例如 https://api.openai.com/v1 —— 探测时会拼 /models。',
      'anthropic-messages': '填到版本段，例如 https://api.anthropic.com/v1 —— 探测时会拼 /v1/models。'
    }

    function ModelSettingsSection() {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [selected, setSelected] = React.useState('')
      const [keyDrafts, setKeyDrafts] = React.useState({})
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [custom, setCustom] = React.useState({
        route: '',
        displayName: '',
        baseURL: '',
        protocol: 'openai-completions',
        apiKey: '',
        models: ''
      })
      const [probe, setProbe] = React.useState({ status: 'idle', data: null, error: null })
      const [pick, setPick] = React.useState('')

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api('/model-config')
          .then((data) => {
            setState({ status: 'ready', data, error: null })
            setSelected((current) => current || (data.providers && data.providers[0] ? data.providers[0].provider : 'custom'))
            if (data.selection) setPick(`${data.selection.provider}::${data.selection.model}`)
          })
          .catch((error) => setState({ status: 'error', data: null, error: error.message }))
      }, [])
      React.useEffect(load, [load])

      const providers = (state.data && state.data.providers) || []
      const active = providers.find((item) => item.provider === selected) || null
      const selection = (state.data && state.data.selection) || null
      const customMode = selected === 'custom'

      const saveKey = (row, clear) => {
        const value = clear ? '' : String(keyDrafts[row.provider] || '').trim()
        if (!clear && !value) {
          setNotice('请先把 Key 填进输入框，再点保存')
          return
        }
        setBusy(`key:${row.provider}`)
        setNotice(null)
        api('/model-config/credential', { method: 'POST', body: JSON.stringify({ ref: row.keyRef, value }) })
          .then((result) => {
            setKeyDrafts((d) => ({ ...d, [row.provider]: '' }))
            setBusy(null)
            setNotice(`${row.displayName || row.provider} ${clear ? '已清除' : '已保存'}`)
            setState({ status: 'ready', data: result.config, error: null })
            // Key 变了 → 旧探测结果作废（模型可用性是随 Key 变的）
            setProbe({ status: 'idle', data: null, error: null })
          })
          .catch((error) => {
            setBusy(null)
            setNotice(`保存失败：${error.message}`)
          })
      }

      const saveCustom = () => {
        const models = String(custom.models || '')
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean)
        if (!custom.route.trim()) {
          setNotice('请先填提供方标识（小写字母开头，例如 my-gateway）')
          return
        }
        if (!custom.baseURL.trim()) {
          setNotice('请先填服务地址（例如 https://api.openai.com/v1）')
          return
        }
        if (models.length === 0) {
          setNotice('请至少填一个模型 id（每行一个，或用逗号分隔）')
          return
        }
        setBusy('custom')
        setNotice(null)
        api('/model-provider/custom', { method: 'POST', body: JSON.stringify({ ...custom, models }) })
          .then((result) => {
            setBusy(null)
            setNotice(`自定义提供方 ${custom.route} 已保存`)
            setState({ status: 'ready', data: result.config, error: null })
            setSelected(custom.route)
          })
          .catch((error) => {
            setBusy(null)
            setNotice(`保存失败：${error.message}`)
          })
      }

      const refreshModels = (row) => {
        setProbe({ status: 'loading', data: null, error: null })
        api(`/models/available?provider=${encodeURIComponent(row.provider)}`)
          .then((data) => setProbe({ status: 'ready', data, error: null }))
          .catch((error) => setProbe({ status: 'ready', data: null, error: error.message }))
      }

      const savePick = () => {
        const parts = String(pick || '').split('::')
        const provider = parts[0]
        const model = parts.slice(1).join('::')
        if (!provider || !model) {
          setNotice('请先在模型列表里选一个模型')
          return
        }
        setBusy('pick')
        setNotice(null)
        api('/model-selected', { method: 'POST', body: JSON.stringify({ provider, model }) })
          .then(() => {
            setBusy(null)
            setNotice(`右侧 AI 栏现在使用：${model}（${provider}）`)
            load()
          })
          .catch((error) => {
            setBusy(null)
            setNotice(`设置失败：${error.message}`)
          })
      }

      const header = h('h2', { className: 'xybSecTitle' }, '模型与 API Key')
      if (state.status === 'loading') {
        return h('section', { className: 'xybSetBlock' }, header, h('p', { className: 'xybHint' }, '正在读取模型提供方…'))
      }
      if (state.status === 'error') {
        return h(
          'section',
          { className: 'xybSetBlock' },
          header,
          h('p', { className: 'xybHint' }, `读不到模型配置：${state.error}`),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', { className: 'xybKeyState' }, '状态', h('span', { className: 'xybKeyMeta' }, '未知（接口不可用）')),
            h('button', { type: 'button', className: 'xybBtn', onClick: load }, '重试')
          )
        )
      }

      const data = state.data || {}
      if (data.available === false) {
        return h(
          'section',
          { className: 'xybSetBlock' },
          header,
          h('p', { className: 'xybHint' }, data.reason || '宿主未提供凭据服务，本机无法配置 API Key。'),
          h('p', { className: 'xybHint' }, '不会因此出现输入框 —— 宁可显示「不能配」，也不做一个存到别处、宿主读不到的假输入口。')
        )
      }

      // ── 提供方下拉（默认只露这一行）
      const options = providers.map((row) => h('option', { key: row.provider, value: row.provider }, `${row.displayName || row.provider}${row.configured ? '（已配 Key）' : ''}`))
      options.push(h('option', { key: 'custom', value: 'custom' }, '自定提供方…（填名称 + URL + Key + 模型）'))

      const providerPanel = customMode
        ? h(
            'div',
            null,
            h('span', { className: 'xybSubTitle' }, '自定义提供方'),
            h(
              'div',
              { className: 'xybKeyRow' },
              h('input', {
                className: 'xybKeyInput',
                'aria-label': '提供方标识',
                placeholder: '提供方标识（小写字母+连字符，例如 my-gateway）',
                value: custom.route,
                onChange: (e) => setCustom((c) => ({ ...c, route: e.target.value }))
              }),
              h('input', {
                className: 'xybKeyInput',
                'aria-label': '显示名称',
                placeholder: '显示名称（可留空，例如 我的网关）',
                value: custom.displayName,
                onChange: (e) => setCustom((c) => ({ ...c, displayName: e.target.value }))
              })
            ),
            h(
              'div',
              { className: 'xybKeyRow' },
              h('select', {
                className: 'xybKeyInput',
                'aria-label': '协议',
                value: custom.protocol,
                onChange: (e) => setCustom((c) => ({ ...c, protocol: e.target.value }))
              }, Object.keys(PROTOCOL_LABEL).map((key) => h('option', { key, value: key }, PROTOCOL_LABEL[key]))),
              h('input', {
                className: 'xybKeyInput',
                'aria-label': '服务地址',
                placeholder: '服务地址，例如 https://api.openai.com/v1',
                value: custom.baseURL,
                onChange: (e) => setCustom((c) => ({ ...c, baseURL: e.target.value }))
              })
            ),
            h('p', { className: 'xybHint' }, PROTOCOL_HINT[custom.protocol] || ''),
            h(
              'div',
              { className: 'xybKeyRow' },
              h('input', {
                className: 'xybKeyInput',
                type: 'password',
                autoComplete: 'off',
                'aria-label': '自定义提供方的 API Key',
                placeholder: 'API Key',
                value: custom.apiKey,
                onChange: (e) => setCustom((c) => ({ ...c, apiKey: e.target.value }))
              }),
              h('input', {
                className: 'xybKeyInput',
                'aria-label': '可用模型 id',
                placeholder: '模型 id（可多个：逗号或换行分隔）',
                value: custom.models,
                onChange: (e) => setCustom((c) => ({ ...c, models: e.target.value }))
              })
            ),
            h(
              'div',
              { className: 'xybKeyRow' },
              h('span', { className: 'xybKeyMeta' }, '凭据名会按标识自动派生（例如 my-gateway → MY_GATEWAY_API_KEY）'),
              h(
                'button',
                { type: 'button', className: 'xybBtn xybBtn--primary', disabled: busy === 'custom', onClick: saveCustom },
                busy === 'custom' ? '保存中…' : '保存自定义提供方'
              )
            )
          )
        : active
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'xybKeyRow' },
                h(
                  'span',
                  null,
                  h('span', { className: 'xybKeyMeta' }, `${active.provider} · ${active.keyRef}`),
                  h(
                    'span',
                    { className: 'xybKeyState', 'data-on': active.configured ? 'true' : 'false', style: { display: 'block', marginTop: 2 } },
                    active.error
                      ? `读取失败：${active.error}`
                      : active.configured
                        ? `已配置${active.source ? ` · 来源 ${active.source}` : ''}`
                        : '未配置'
                  )
                ),
                h('span', { className: 'xybKeyMeta' }, active.baseURL || '（宿主未提供地址）'),
                h('span', { className: 'xybKeyMeta' }, PROTOCOL_LABEL[active.protocol] || active.protocol)
              ),
              h(
                'div',
                { className: 'xybKeyRow' },
                h('input', {
                  className: 'xybKeyInput',
                  type: 'password',
                  autoComplete: 'off',
                  'aria-label': `${active.keyRef} 的值`,
                  placeholder: active.configured ? '重新输入可覆盖（不会显示已保存的值）' : '粘贴 API Key',
                  value: keyDrafts[active.provider] || '',
                  onChange: (e) => setKeyDrafts((d) => ({ ...d, [active.provider]: e.target.value }))
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'xybBtn xybBtn--primary',
                    disabled: busy === `key:${active.provider}` || active.writable === false,
                    onClick: () => saveKey(active, false)
                  },
                  busy === `key:${active.provider}` ? '保存中…' : '保存'
                ),
                active.configured
                  ? h('button', { type: 'button', className: 'xybBtn', disabled: busy === `key:${active.provider}`, onClick: () => saveKey(active, true) }, '清除')
                  : null
              )
            )
          : h('p', { className: 'xybHint' }, '宿主没有登记任何可配置的模型提供方 —— 用上面的「自定提供方…」添加一个。')

      // ── 右侧 AI 栏使用的模型
      const probeData = probe.data || null
      const modelOptions = probeData && probeData.available ? probeData.models : []
      const canProbe = active && active.configured && probe.status !== 'loading'
      const modelPanel = h(
        'div',
        null,
        h('span', { className: 'xybSubTitle' }, '右侧 AI 栏使用的模型'),
        selection
          ? h('p', { className: 'xybHint' }, `当前：${selection.model}（${selection.provider}）`)
          : h('p', { className: 'xybHint' }, '当前：未设置 —— 首次使用前请先在上面填好 API Key，再刷新模型列表挑一个。'),
        !active || !active.configured
          ? h('p', { className: 'xybHint' }, '先填写 API Key 并保存，才能刷新可用模型（没有 Key 的提供方不会返回任何模型）。')
          : null,
        h(
          'div',
          { className: 'xybKeyRow' },
          h(
            'button',
            { type: 'button', className: 'xybBtn', disabled: !canProbe, onClick: () => refreshModels(active) },
            probe.status === 'loading' ? '探测中…' : '刷新可用模型'
          ),
          probe.status === 'ready' && probeData && !probeData.available
            ? h('span', { className: 'xybKeyMeta' }, probeData.message || probe.error || '没有可用模型')
            : null,
          probeData && probeData.available
            ? h(
                'select',
                {
                  className: 'xybKeyInput',
                  'aria-label': '可用模型',
                  value: pick,
                  onChange: (e) => setPick(e.target.value)
                },
                h('option', { value: '' }, `选择模型（共 ${modelOptions.length} 个可用）`),
                modelOptions.map((model) => h('option', { key: `${model.provider}::${model.id}`, value: `${model.provider}::${model.id}` }, `${model.name} · ${model.providerName}`))
              )
            : null,
          probeData && probeData.available
            ? h('button', { type: 'button', className: 'xybBtn xybBtn--primary', disabled: busy === 'pick', onClick: savePick }, busy === 'pick' ? '保存中…' : '设为当前模型')
            : null
        ),
        probeData && probeData.available && modelOptions.length === 0
          ? h('p', { className: 'xybHint' }, '接口返回 200，但没有列出任何模型 —— 请检查这个提供方是否支持 /models。')
          : null
      )

      return h(
        'section',
        { className: 'xybSetBlock' },
        header,
        h('p', { className: 'xybHint' }, '对话模型由右侧「AI 协助」面板使用；这里的 Key 写入宿主凭据存储（与宿主设置面板同一份），本工作台不留副本。'),
        h(
          'div',
          { className: 'xybKeyRow' },
          h('span', { className: 'xybSetLabel' }, '提供方'),
          h(
            'select',
            {
              className: 'xybKeyInput',
              'aria-label': '模型提供方',
              value: selected,
              onChange: (e) => {
                setSelected(e.target.value)
                setProbe({ status: 'idle', data: null, error: null })
              }
            },
            options
          )
        ),
        providerPanel,
        h('div', { className: 'xybKeyRow' }, h('span', { className: 'xybKeyMeta' }, '')), 
        modelPanel,
        (data.notes || []).map((note, index) => h('p', { key: index, className: 'xybHint', style: { marginTop: 6 } }, note)),
        notice ? h('p', { className: 'xybHint', style: { marginTop: 8 } }, notice) : null
      )
    }


    // ─────────────────────────────── 病情一图秀
    //
    // 同一时间轴对齐「指标趋势」与「用药时间轴」（原型 timelineHTML）：
    // 方案切换点与指标拐点必须能在同一 x 轴上比较。
    const YEAR_MIN = 1990

    const msOfDay = (value) => {
      const t = Date.parse(String(value))
      return Number.isFinite(t) ? t : null
    }

    /** 时间轴图（x 用同一 [from,to] 域；y 每图独立） */
    function TimelineChart({ points, tone, from, to, showPoints, label }) {
      if (!Array.isArray(points) || points.length === 0 || !(to > from)) return null
      const usable = points.filter((p) => Number.isFinite(Number(p.value)) && msOfDay(p.at) !== null)
      if (usable.length === 0) return null
      const values = usable.map((p) => Number(p.value))
      const min = Math.min(...values)
      const max = Math.max(...values)
      const span = max - min || 1
      const x = (at) => ((msOfDay(at) - from) / (to - from)) * 100
      const y = (v) => 30 - ((v - min) / span) * 26
      const d = usable
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${Math.min(100, Math.max(0, x(p.at))).toFixed(2)},${y(Number(p.value)).toFixed(2)}`)
        .join(' ')
      return h(
        'svg',
        {
          className: `xybSpark ${tone || 'neutral'}`,
          viewBox: '0 0 100 32',
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': label || '时间轴趋势'
        },
        h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 2, vectorEffect: 'non-scaling-stroke' }),
        showPoints
          ? usable.map((p, i) =>
              h('circle', {
                key: i,
                cx: Math.min(100, Math.max(0, x(p.at))).toFixed(2),
                cy: y(Number(p.value)).toFixed(2),
                r: 1.4,
                fill: 'currentColor'
              })
            )
          : null
      )
    }

    /** 病情一图秀（真数据：/patient/series 的 series + medications） */
    function PageTimeline({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', series: {}, medications: [], error: null })
      const [years, setYears] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [showPoints, setShowPoints] = React.useState(true)
      const [showRate, setShowRate] = React.useState(false)

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/series?id=${encodeURIComponent(patient.id)}`)
          .then((data) => {
            const series = data.series || {}
            const keys = Object.keys(series)
            const all = keys.flatMap((key) => series[key].map((p) => p.at)).filter(Boolean).sort()
            const firstYear = all.length ? Number(String(all[0]).slice(0, 4)) : new Date().getFullYear()
            const lastYear = all.length ? Number(String(all[all.length - 1]).slice(0, 4)) : firstYear
            setYears([firstYear, lastYear])
            setSelected(keys.slice(0, 4))
            setState({ status: 'ready', series, medications: data.medications || [], error: null })
          })
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])

      React.useEffect(load, [load])

      if (state.status === 'loading' || !years) return h('div', { className: 'xybLoading' }, '正在读取时间轴…')
      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试')
        )
      }

      const keys = Object.keys(state.series)
      const picked = (selected || []).filter((key) => keys.includes(key))
      const from = Date.parse(`${years[0]}-01-01T00:00:00Z`)
      const to = Date.parse(`${years[1]}-12-31T23:59:59Z`)

      const rateText = (points) => {
        const usable = points.filter((p) => Number.isFinite(Number(p.value)) && msOfDay(p.at) !== null)
        if (usable.length < 2) return null
        const first = usable[0]
        const last = usable[usable.length - 1]
        const days = (msOfDay(last.at) - msOfDay(first.at)) / 86400000
        if (!(days > 0)) return null
        const perMonth = ((Number(last.value) - Number(first.value)) / days) * 30.44
        return `速率 ≈ ${perMonth >= 0 ? '+' : ''}${Math.round(perMonth * 100) / 100}/月`
      }

      const meds = (state.medications || [])
        .map((med) => {
          const start = msOfDay(med.startedAt)
          if (start === null) return null
          const end = msOfDay(med.endedAt)
          return { ...med, start, end: end === null || end > to ? to : end }
        })
        .filter(Boolean)

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '动态病情一图秀'),
        h(
          'div',
          { className: 'xybControls' },
          h(
            'div',
            { className: 'xybControl' },
            '时间筛选（年）',
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                type: 'number',
                'aria-label': '起始年份',
                min: YEAR_MIN,
                max: years[1],
                value: years[0],
                onChange: (e) => setYears([Number(e.target.value) || YEAR_MIN, years[1]])
              }),
              '–',
              h('input', {
                type: 'number',
                'aria-label': '结束年份',
                min: years[0],
                max: 2100,
                value: years[1],
                onChange: (e) => setYears([years[0], Number(e.target.value) || years[0]])
              })
            )
          ),
          h(
            'div',
            { className: 'xybControl' },
            '显示控制',
            h(
              'div',
              { style: { display: 'flex', gap: 12 } },
              h('label', { className: 'xybCheck' }, h('input', { type: 'checkbox', checked: showPoints, onChange: (e) => setShowPoints(e.target.checked) }), '数据点'),
              h('label', { className: 'xybCheck' }, h('input', { type: 'checkbox', checked: showRate, onChange: (e) => setShowRate(e.target.checked) }), '速率')
            )
          )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, `指标趋势图（${years[0]}–${years[1]}）`),
          h('p', { className: 'xybTabsLine' }, '选择指标（最多 8 个，共享同一时间轴）'),
          h(
            'div',
            { className: 'xybChips' },
            keys.map((key) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'xybChip',
                  'aria-pressed': picked.includes(key),
                  onClick: () =>
                    setSelected((list) => {
                      const current = list || []
                      if (current.includes(key)) return current.filter((x) => x !== key)
                      if (current.length >= MAX_COMPARE) return current
                      return [...current, key]
                    })
                },
                key
              )
            )
          ),
          keys.length === 0
            ? h('div', { className: 'xybEmpty' }, h('strong', null, '还没有可画的时间轴数据'), h('p', null, '先在「报告核对」确认记录，指标与用药才会出现在这里。'))
            : picked.map((key) => {
                const points = state.series[key] || []
                const usable = points.filter((p) => Number.isFinite(Number(p.value)))
                const latest = usable[usable.length - 1]
                const rate = rateText(points)
                return h(
                  'div',
                  { key, className: 'xybCard', style: { marginBottom: 10 } },
                  h(
                    'div',
                    { className: 'xybCardHead' },
                    h('span', { className: 'xybName' }, key),
                    h('span', { className: 'xybCardSub' }, latest ? `${fmtNumber(latest.value)}${latest.unit ? ` ${latest.unit}` : ''} · ${latest.at}` : '无有效数据')
                  ),
                  h('div', { className: 'xybCardSub' }, `${usable.length} 次记录${showRate && rate ? ` · ${rate}` : ''}`),
                  h(TimelineChart, { points, from, to, showPoints, label: `${key} 时间轴趋势` })
                )
              })
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '用药时间轴'),
          meds.length === 0
            ? h('p', { className: 'xybHint' }, '还没有用药记录。可在「病情整理 → 病情评估」的治疗经过里登记方案（时间轴只读）。')
            : meds.map((med, index) => {
                const left = Math.min(100, Math.max(0, ((med.start - from) / (to - from)) * 100))
                const right = Math.min(100, Math.max(0, ((med.end - from) / (to - from)) * 100))
                return h(
                  'div',
                  { key: med.id || index, className: 'xybMedRow' },
                  h('span', { className: 'xybMedLabel' }, `${med.line ? `${med.line}线 · ` : ''}${med.name || '未命名方案'}`),
                  h(
                    'div',
                    { className: 'xybMedTrack', role: 'img', 'aria-label': `${med.name} 用药区间` },
                    h('div', { className: 'xybMedBar', style: { left: `${left}%`, width: `${Math.max(1, right - left)}%` } })
                  )
                )
              })
        ),
        h('p', { className: 'xybHint' }, '用药时间轴为只读；编辑请到「病情整理 → 病情评估 → 治疗经过」。'),
        h('div', { className: 'xybDisclaimer' }, '以上为指标数值与用药记录的呈现，不构成诊断或治疗建议。具体含义请以医生解释为准。')
      )
    }

    // ─────────────────────────────── 心理支持
    //
    // 医学红线在本页最集中：
    // M-3：只呈现分数，不解读（界面明说）；
    // M-5：四个子页（自评/缓解/安宁/哀伤）**每一页**都渲染危机资源。
    const PSYCH_VIEWS = [
      { key: 'assess', label: '情绪自评' },
      { key: 'relief', label: '心理缓解' },
      { key: 'hospice', label: '安宁疗护' },
      { key: 'grief', label: '哀伤管理' }
    ]

    /** 危机兜底（M-5）：不是可选项，每次渲染都在。 */
    function CrisisBox({ crisis }) {
      if (!crisis) return null
      return h(
        'section',
        { className: 'xybCrisis', role: 'region', 'aria-label': '危机资源' },
        h('strong', null, crisis.title),
        h('p', null, crisis.statement),
        h(
          'ul',
          null,
          (crisis.hotlines || []).map((hotline) =>
            h(
              'li',
              { key: hotline.number },
              h('b', null, `${hotline.name}：`),
              h('a', { href: `tel:${String(hotline.number).replace(/[^0-9+]/g, '')}` }, hotline.number),
              h('span', { className: 'xybHint' }, `（${hotline.note}）`)
            )
          )
        ),
        h('p', { className: 'xybHint' }, '热线号码如有变动，以当地公布为准。')
      )
    }

    /** 心理支持（真数据：/psych/scales + /psych/resources + /patient/psych） */
    function PagePsych({ patient }) {
      const [view, setView] = React.useState('assess')
      const [state, setState] = React.useState({ status: 'loading', error: null, notice: null, saving: false, payload: null })
      const [form, setForm] = React.useState({ scale: 'PHQ-9', score: '', takenAt: new Date().toISOString().slice(0, 10), note: '' })

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        const tasks = [api('/psych/scales'), api('/psych/resources')]
        if (patient) tasks.push(api(`/patient/psych?id=${encodeURIComponent(patient.id)}`))
        Promise.all(tasks)
          .then(([scales, resources, scores]) =>
            setState((s) => ({
              ...s,
              status: 'ready',
              error: null,
              saving: false,
              // 保留 notice：load() 在保存成功后会被调用，不能把「已记录」提示擦掉
              payload: { scales, resources, scores: scores || { items: [] } }
            }))
          )
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient ? patient.id : null])

      React.useEffect(load, [load])

      const save = () => {
        if (!patient) return
        setState((s) => ({ ...s, saving: true, error: null, notice: null }))
        api(`/patient/psych?id=${encodeURIComponent(patient.id)}`, { method: 'POST', body: JSON.stringify(form) })
          .then(() => {
            setForm((f) => ({ ...f, score: '', note: '' }))
            setState((s) => ({ ...s, saving: false, notice: '已记录。工作台不对分数做解读。' }))
            load()
          })
          .catch((error) => setState((s) => ({ ...s, saving: false, error: error.message })))
      }

      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试')
        )
      }

      // 注意顺序：错误分支必须在 payload 守卫**之前**——
      // 否则 payload 尚未拿到时，!payload 会先命中加载态，错误永远显示不出来。
      if (state.status === 'loading' || !state.payload) return h('div', { className: 'xybLoading' }, '正在读取心理支持资源…')

      const { scales, resources, scores } = state.payload
      const items = scores.items || []

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '心理支持'),
        h(
          'nav',
          { className: 'xybChips', role: 'tablist', 'aria-label': '心理支持子页' },
          PSYCH_VIEWS.map((entry) =>
            h(
              'button',
              { key: entry.key, type: 'button', role: 'tab', className: 'xybChip', 'aria-pressed': view === entry.key, 'aria-selected': view === entry.key, onClick: () => setView(entry.key) },
              entry.label
            )
          )
        ),
        h(CrisisBox, { crisis: resources.crisis }),
        view === 'assess'
          ? h(
              'section',
              { className: 'xybSec' },
              h('h3', { className: 'xybSecTitle' }, '情绪自评'),
              h('p', { className: 'xybTabsLine' }, scales.note),
              patient
                ? h(
                    'div',
                    { className: 'xybControls' },
                    h(
                      'div',
                      { className: 'xybControl' },
                      '量表',
                      h(
                        'select',
                        { 'aria-label': '量表', value: form.scale, onChange: (e) => setForm((f) => ({ ...f, scale: e.target.value })) },
                        (scales.scales || []).map((scale) => h('option', { key: scale.id, value: scale.id }, scale.name))
                      )
                    ),
                    h('div', { className: 'xybControl' }, '分数', h('input', { type: 'number', 'aria-label': '分数', value: form.score, onChange: (e) => setForm((f) => ({ ...f, score: e.target.value })) })),
                    h('div', { className: 'xybControl' }, '日期', h('input', { type: 'text', placeholder: 'YYYY-MM-DD', 'aria-label': '日期', value: form.takenAt, onChange: (e) => setForm((f) => ({ ...f, takenAt: e.target.value })) })),
                    h('div', { className: 'xybControl' }, '备注（可选）', h('input', { type: 'text', 'aria-label': '备注', value: form.note, onChange: (e) => setForm((f) => ({ ...f, note: e.target.value })) })),
                    h('button', { type: 'button', className: 'xybBtn xybBtn--primary', disabled: state.saving || form.score === '', onClick: save }, state.saving ? '正在保存…' : '记录分数')
                  )
                : h('p', { className: 'xybHint' }, '先建立患者档案，才能把分数记录到档案下。'),
              state.notice ? h('div', { className: 'xybNotice' }, state.notice) : null,
              state.error ? h('div', { className: 'xybError', style: { margin: '10px 0' } }, state.error) : null,
              h('h4', { className: 'xybSecTitle', style: { marginTop: 16 } }, `已记录的分数（${items.length}）`),
              items.length === 0
                ? h('p', { className: 'xybHint' }, '还没有记录。')
                : items
                    .slice()
                    .reverse()
                    .map((item) =>
                      h(
                        'div',
                        { key: item.id, className: 'xybSetRow', role: 'listitem' },
                        h('span', null, h('span', { className: 'xybSetLabel' }, item.scale), h('span', { className: 'xybSetDesc' }, `${item.takenAt}${item.note ? ` · ${item.note}` : ''}`)),
                        h('span', { className: 'xybVal', style: { flex: 'initial' } }, `${item.score} 分`)
                      )
                    )
            )
          : null,
        view === 'relief'
          ? h(
              'section',
              { className: 'xybSec' },
              h('h3', { className: 'xybSecTitle' }, '心理缓解'),
              (resources.relief?.methods || []).map((method) =>
                h('div', { key: method.title, className: 'xybSetRow', role: 'listitem' },
                  h('span', null, h('span', { className: 'xybSetLabel' }, method.title), h('span', { className: 'xybSetDesc' }, method.detail)))
              ),
              h('p', { className: 'xybHint' }, resources.relief?.note || '')
            )
          : null,
        view === 'hospice'
          ? h(
              'section',
              { className: 'xybSec' },
              h('h3', { className: 'xybSecTitle' }, '安宁疗护'),
              (resources.hospice?.faq || []).map((item) =>
                h('div', { key: item.q, style: { marginBottom: 10 } },
                  h('span', { className: 'xybSetLabel' }, item.q),
                  h('p', { className: 'xybHint' }, item.a))
              ),
              h('p', { className: 'xybHint' }, resources.hospice?.note || '')
            )
          : null,
        view === 'grief'
          ? h(
              'section',
              { className: 'xybSec' },
              h('h3', { className: 'xybSecTitle' }, '哀伤管理'),
              (resources.grief || []).map((note) =>
                h('div', { key: note.title, style: { marginBottom: 10 } },
                  h('span', { className: 'xybSetLabel' }, note.title),
                  h('p', { className: 'xybHint' }, note.detail))
              )
            )
          : null,
        h('p', { className: 'xybHint' }, '本页内容不构成诊断或心理治疗建议；危机时请优先联系上方热线或急诊。')
      )
    }

    // ─────────────────────────────── 营养管理
    //
    // 真数据：体重（/patient/series）。能量目标与摄入记录需要数据模型，
    // 本期如实留空——**不给能量配方、不给剂量**（M-2）。
    function PageNutrition({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', weight: [], error: null })
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/series?id=${encodeURIComponent(patient.id)}&indicators=WEIGHT`)
          .then((data) => setState({ status: 'ready', weight: (data.series && data.series.WEIGHT) || [], error: null }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])
      React.useEffect(load, [load])

      if (state.status === 'error') {
        return h('div', null, h('div', { className: 'xybError' }, state.error), h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试'))
      }
      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取营养相关记录…')

      const points = state.weight || []
      const latest = points[points.length - 1] || null
      const prev = points.length > 1 ? points[points.length - 2] : null
      const delta = prev && latest ? ((Number(latest.value) - Number(prev.value)) / Number(prev.value)) * 100 : null

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '营养管理'),
        h('p', { className: 'xybTabsLine' }, '箭头与颜色由指标方向语义判定（体重下降为需关注），不由箭头方向决定。'),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '当前状态'),
          latest
            ? h(
                'div',
                { className: 'xybCard' },
                h('div', { className: 'xybCardHead' },
                  h('span', { className: 'xybName' }, '体重'),
                  h('span', { className: `xybLv ${delta !== null && delta < -2 ? 'watch' : 'good'}` }, delta !== null && delta < -2 ? '需关注' : '已记录')),
                h('div', { className: 'xybCardVal' }, `${fmtNumber(latest.value)} kg`),
                h('div', { className: 'xybCardSub' }, `${latest.at}${delta !== null ? ` · 较上次 ${delta >= 0 ? '+' : ''}${Math.round(delta * 10) / 10}%` : ''}`),
                h(Spark, { points, tone: delta !== null && delta < -2 ? 'watch' : 'good' })
              )
            : h('p', { className: 'xybHint' }, '还没有体重记录。可在「报告核对」确认，或走「病情整理」手工录入。'),
          delta !== null && delta < -2
            ? h('p', { className: 'xybHint' }, '体重下降较明显时，建议带去复诊与营养门诊讨论（本工作台不给出营养处方）。')
            : null
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '能量与蛋白目标'),
          h(
            'div',
            { className: 'xybTodo' },
            h('strong', null, '摄入记录尚未实现'),
            h('p', null, '能量/蛋白目标需要体重、活动量与病情共同计算，并需要每日摄入记录才能看缺口——这两块尚未提供，会在后续版本加入。'),
            h('p', { className: 'xybTodoNote' }, '本工作台不给能量配方，也不给补充剂剂量（M-2）。')
          )
        ),
        h(
          'section',
          { className: 'xybSec' },
          h('h3', { className: 'xybSecTitle' }, '胰酶替代（PEI）'),
          h('p', { className: 'xybHint' }, '胰酶替代的启动、剂量与用法均由医生决定；如有油便、腹泻、体重下降，请复诊讨论。'),
          h('p', { className: 'xybHint' }, '本工作台不提供剂量估算与用药建议。')
        ),
        h('div', { className: 'xybDisclaimer' }, '以上为记录与趋势的呈现，不构成诊断、营养处方或用药建议。具体请以医生与临床营养师意见为准。')
      )
    }

    // ─────────────────────────────── 临床匹配
    //
    // 真数据：入组档案 = 病情评估那份档案（同一模型，只读展示）。
    // 检索/分析/收藏/渠道需要 的领域能力，本期如实声明；
    // **M-4：没有任何自动入组判定。**
    const MATCH_VIEWS = [
      { key: 'profile', label: '入组档案' },
      { key: 'trials', label: '试验检索' },
      { key: 'analysis', label: '匹配分析' },
      { key: 'saved', label: '收藏' },
      { key: 'channels', label: '渠道配置' }
    ]

    function PageMatch({ patient }) {
      const [view, setView] = React.useState('profile')
      const [state, setState] = React.useState({ status: 'loading', assess: null, error: null })
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/assess?id=${encodeURIComponent(patient.id)}`)
          .then((assess) => setState({ status: 'ready', assess, error: null }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])
      React.useEffect(load, [load])

      if (state.status === 'error') {
        return h('div', null, h('div', { className: 'xybError' }, state.error), h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试'))
      }
      if (state.status === 'loading' || !state.assess) return h('div', { className: 'xybLoading' }, '正在读取入组档案…')

      const a = state.assess
      const todo = (title, detail) =>
        h('div', { className: 'xybTodo' }, h('strong', null, title), h('p', null, detail), h('p', { className: 'xybTodoNote' }, '这里先不铺演示数据。'))

      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '临床匹配'),
        h(
          'nav',
          { className: 'xybChips', role: 'tablist', 'aria-label': '临床匹配子页' },
          MATCH_VIEWS.map((entry) =>
            h('button', { key: entry.key, type: 'button', role: 'tab', className: 'xybChip', 'aria-pressed': view === entry.key, 'aria-selected': view === entry.key, onClick: () => setView(entry.key) }, entry.label)
          )
        ),
        view === 'profile'
          ? h(
              'section',
              { className: 'xybSec' },
              h('h3', { className: 'xybSecTitle' }, '入组档案'),
              h('p', { className: 'xybTabsLine' }, '与「病情评估」共用同一份档案；编辑请去「病情整理 → 病情评估」。'),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '基本'), h('span', { className: 'xybSetDesc' }, `年龄 ${a.basic.age ?? '未填写'} · 性别 ${a.basic.sex === 'male' ? '男' : a.basic.sex === 'female' ? '女' : '未填写'} · ECOG ${a.basic.ecog ?? '未填写'}`))),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '诊断与病理'), h('span', { className: 'xybSetDesc' }, `${a.diagnosis.primary || '未填写'} · ${a.diagnosis.histology || '组织学未填写'} · 分期 ${a.diagnosis.stage || '未填写'}`))),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '分子特征'), h('span', { className: 'xybSetDesc' }, (a.diagnosis.gene || []).join('、') || '未填写'))),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '病理 / IHC'), h('span', { className: 'xybSetDesc' }, (a.diagnosis.ihc || []).join('、') || '未填写'))),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '治疗线数'), h('span', { className: 'xybSetDesc' }, (a.treatment.lines || []).map((line) => line.name || '未命名').join(' → ') || '未填写'))),
              h('div', { className: 'xybSetRow' }, h('span', null, h('span', { className: 'xybSetLabel' }, '待补充项'), h('span', { className: 'xybSetDesc' }, (a.pending || []).join('、') || '无')))
            )
          : null,
        view === 'trials' ? todo('试验检索尚未实现', '公开试验登记库的检索尚未提供；检索通道未启用时会在本页明示。') : null,
        view === 'analysis'
          ? h(
              'section',
              { className: 'xybSec' },
              todo('匹配分析尚未实现', '入排标准逐条对照尚未提供。'),
              h('p', { className: 'xybHint' }, '任何情况下本工作台都不做自动入组资格判定：需医生评估的项一律标「待人工」，不会计入「符合」（M-4）。')
            )
          : null,
        view === 'saved' ? todo('收藏尚未实现', '试验收藏与备注尚未提供。') : null,
        view === 'channels' ? h(QingnangSettingsSection, null) : null
      )
    }

    // ─────────────────────────────── 全程管理
    //
    // 真数据：看板的 careDigest（前两类来自已有记录；带管/血管通路等 ）。
    function PageCare({ patient }) {
      const [state, setState] = React.useState({ status: 'loading', board: null, error: null })
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api(`/patient/board?id=${encodeURIComponent(patient.id)}`)
          .then((board) => setState({ status: 'ready', board, error: null }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [patient.id])
      React.useEffect(load, [load])

      if (state.status === 'error') {
        return h('div', null, h('div', { className: 'xybError' }, state.error), h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试'))
      }
      if (state.status === 'loading' || !state.board) return h('div', { className: 'xybLoading' }, '正在读取全程管理状态…')

      const digest = state.board.careDigest || []
      return h(
        'div',
        null,
        h('h2', { className: 'xybSecTitle' }, '全程管理'),
        h('p', { className: 'xybTabsLine' }, '毒性 / 并发症 / 带管 / 血管通路四类；状态来自已确认记录。'),
        digest.map((item) =>
          h(
            'div',
            { key: item.key, className: 'xybSetRow', role: 'listitem' },
            h('span', null, h('span', { className: 'xybSetLabel' }, item.label), h('span', { className: 'xybSetDesc' }, item.detail || '暂无说明')),
            h('span', { className: `xybLv ${item.lv}` }, LV_LABEL[item.lv] || item.lv)
          )
        ),
        h(
          'div',
          { className: 'xybTodo', style: { marginTop: 16 } },
          h('strong', null, '四类管理的逐条记录尚未实现'),
          h('p', null, '毒性分级、并发症、带管维护、血管通路档案的录入与时间线尚未提供，会在后续版本加入。'),
          h('p', { className: 'xybTodoNote' }, '本页先展示能从已有记录推导出的状态，不铺演示数据。')
        ),
        h('div', { className: 'xybDisclaimer' }, '以上为记录与状态的呈现，不构成诊断或治疗建议。具体请以医生意见为准。')
      )
    }

    // ─────────────────────────────── 设置页（M11-1 最小可用版；M11-8 增补 1:1 细节）
    // 只展示后端真实提供的字段（parseMode/parseModel/privacyAckAt/dataRootOverride
    // + /storage/stats），没有实现的能力明说未实现——不造死按钮。
    const formatBytes = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let i = 0
      let x = v
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024
        i += 1
      }
      return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`
    }

    const EVENT_LEVEL_LABELS = { error: '错误', warn: '警告', info: '信息' }

    /**
     * 首次设置向导。四步：欢迎与隐私 → 数据目录 → 界面大小 → 建立档案。
     *
     * 设计取舍：
     * · 覆盖层而不拆掉外壳：首次使用时页签与 AI 面板对新人只是噪音，但也不该把它们卸载；
     * · 第二步**当场验证可写**（真写一个探针文件）—— 这是对真实事故 P-35 的正面回应：
     * 用户当时选完目录零反应、无报错；现在这里会直接告诉“能写 / 不能写 + 为什么”；
     * · 第三步直接复用 TextScaleControl：中老年使用者**当场看到**字变大，而不是选完再猜；
     * · 任何一步都能跳过（标记 skipped），下次不再自动弹；设置页可以重新打开。
     */
    function OnboardingWizard({ dataRoot, textScale, onTextScale, onFinish, onSkip, busy, error }) {
      const [step, setStep] = React.useState(0)
      const [probe, setProbe] = React.useState({ status: 'idle', ok: null, detail: '' })
      const [name, setName] = React.useState('')
      const steps = ['欢迎', '数据目录', '界面大小', '建立档案']

      const runProbe = () => {
        setProbe({ status: 'busy', ok: null, detail: '' })
        api('/probe-dir', { method: 'POST', body: JSON.stringify({ path: dataRoot || '' }) })
          .then((data) =>
            setProbe({
              status: 'done',
              ok: data.ok,
              detail: data.ok
                ? `可以正常读写：${data.path}${data.freeBytes ? `（可用 ${(data.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB）` : ''}`
                : `${data.path}：${data.reason}`
            })
          )
          .catch((err) => setProbe({ status: 'done', ok: false, detail: `检测失败：${err.message}` }))
      }

      return h(
        'div',
        { className: 'xybWizardOverlay', role: 'dialog', 'aria-label': '首次设置向导' },
        h(
          'div',
          { className: 'xybWizardCard' },
          h(
            'div',
            { className: 'xybWizardSteps' },
            steps.map((label, index) =>
              h('span', { key: label, className: 'xybWizardStep', 'data-on': index === step ? 'true' : 'false' },
                `${index + 1} ${label}${index < steps.length - 1 ? '  ·' : ''}`)
            )
          ),
          step === 0
            ? h(
                'div',
                null,
                h('h2', { className: 'xybWizardTitle' }, '欢迎使用小胰宝社区版'),
                h('p', { className: 'xybWizardText' },
                  '这是给胰腺癌患者与家属用的病历管理工作台。所有资料都保存在你自己的电脑上，不会上传。'),
                h('p', { className: 'xybWizardText' },
                  '只有两种情况会联网：你在设置里确认隐私闸门后使用云端解析，或你主动启用检索通道。除此之外没有上行。'),
                h('p', { className: 'xybWizardText' },
                  '本工作台不做诊断、不做处方、不解读量表；任何结论请以医生意见为准。'),
                h('p', { className: 'xybWizardResult' }, '下一步会检查数据目录能不能写（约一秒），然后让你选一个看得清的字号。')
              )
            : step === 1
              ? h(
                  'div',
                  null,
                  h('h2', { className: 'xybWizardTitle' }, '数据存放在哪里'),
                  h('p', { className: 'xybWizardText' }, `当前数据目录：${dataRoot || '（默认：应用数据目录下的 xyb/）'}`),
                  h('p', { className: 'xybWizardText' },
                    '点下面的按钮会真的在这个目录里写一个临时文件再删掉 —— 这样能提前发现“目录不能写”这类问题（常见原因：权限、受控文件夹访问、磁盘已满）。'),
                  h('button', { type: 'button', className: 'xybBtn', onClick: runProbe, disabled: probe.status === 'busy' },
                    probe.status === 'busy' ? '检测中…' : '检测能不能写'),
                  probe.status === 'done'
                    ? h('div', { className: 'xybWizardResult', 'data-ok': probe.ok ? 'true' : 'false' }, probe.detail)
                    : null
                )
              : step === 2
                ? h(
                    'div',
                    null,
                    h('h2', { className: 'xybWizardTitle' }, '选一个看得清的大小'),
                    h('p', { className: 'xybWizardText' },
                      '中老年使用者建议「大字」或「特大」——文字与按钮会一起变大，看得清也点得准。以后随时可在顶栏或设置里改。'),
                    h(TextScaleControl, { scale: textScale, onChange: onTextScale, idPrefix: 'xyb-wizard-scale' }),
                    h('p', { className: 'xybWizardText', style: { marginTop: '16px' } },
                      '这是正文示例：一次化验有二十多项指标，工作台会把需要注意的挑出来，并告诉你依据是什么。')
                  )
                : h(
                    'div',
                    null,
                    h('h2', { className: 'xybWizardTitle' }, '建立第一份档案'),
                    h('p', { className: 'xybWizardText' },
                      '之后的病历、指标与用药记录都会归到这份档案下。只需一个称呼（比如“妈妈”），不需要真实姓名。'),
                    h('input', {
                      className: 'xybWizardInput',
                      value: name,
                      maxLength: 40,
                      placeholder: '档案名称',
                      'aria-label': '档案名称',
                      onChange: (event) => setName(event.target.value)
                    }),
                    error ? h('div', { className: 'xybWizardResult', 'data-ok': 'false' }, error) : null
                  ),
          h(
            'div',
            { className: 'xybWizardActions' },
            step > 0 ? h('button', { type: 'button', className: 'xybBtn xybBtn--ghost', onClick: () => setStep(step - 1) }, '上一步') : null,
            step < 3
              ? h('button', { type: 'button', className: 'xybBtn', onClick: () => setStep(step + 1),
                  disabled: step === 1 && probe.status !== 'done' }, '下一步')
              : h('button', { type: 'button', className: 'xybBtn', onClick: () => onFinish(name), disabled: busy || !name.trim() },
                  busy ? '正在建立…' : '完成并开始'),
            h('button', { type: 'button', className: 'xybBtn xybBtn--ghost', onClick: onSkip, disabled: busy }, '先跳过')
          )
        )
      )
    }
    const CHECK_LEVEL_LABELS = { ok: '正常', warn: '需注意', error: '故障' }

    /**
     * 数据自检面板。
     *
     * 语言取「用户能理解」而不是「工程师术语」：不写 JSONL / manifest，而是
     * 「记录文件完整性」「档案清单」这种说法；每项都说清楚「能不能自己修」。
     */
    function SelfCheckPanel({ state, onCheck, onRepair }) {
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'xybEventFilters' },
          h('button', { type: 'button', onClick: onCheck, disabled: state.status === 'loading' },
            state.status === 'loading' ? '检查中…' : '重新检查'),
          state.summary
            ? h('span', { className: 'xybHint', style: { marginLeft: 'auto' } },
                `正常 ${state.summary.ok} · 需注意 ${state.summary.warn} · 故障 ${state.summary.error}`)
            : null
        ),
        state.error ? h('div', { className: 'xybError' }, state.error) : null,
        state.notice ? h('div', { className: 'xybNotice' }, state.notice) : null,
        state.items.length === 0
          ? null
          : h(
              'div',
              { className: 'xybEvents' },
              state.items.map((item) =>
                h(
                  'div',
                  { className: 'xybEventRow', key: item.id },
                  h('span', { className: 'xybEventLevel', 'data-level': item.level }, CHECK_LEVEL_LABELS[item.level] || item.level),
                  h(
                    'span',
                    { className: 'xybEventBody' },
                    h('strong', null, item.label),
                    h('span', { className: 'xybEventMeta' }, ` · ${item.detail}`)
                  ),
                  item.repairable && item.action
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'xybBtn',
                          disabled: state.busy === item.action,
                          onClick: () => onRepair(item.action)
                        },
                        state.busy === item.action ? '修复中…' : '修复'
                      )
                    : null
                )
              )
            ),
        h(
          'p',
          { className: 'xybHint', style: { marginTop: '10px' } },
          '修复前会先在本机做一份完整备份；只处理临时文件、可重建内容与已备份的坏行，不会删除你的档案与记录。'
        )
      )
    }

    /**
     * 本机事件时间线。
     *
     * 为什么把它放在设置页：这是**排障入口**，不是日常操作。但它同时是产品承诺的一部分：
     * 界面上的每一次失败都应该能在时间线里找到对应的一条 ——「失败静默」在本项目里已被真实事故
     * 验证过（工作区创建失败零反馈、就位副本过期发旧界面）。
     */
    function EventTimeline({ state, onLevel, onRefresh }) {
      const levels = [
        ['', '全部'],
        ['error', '错误'],
        ['warn', '警告'],
        ['info', '信息']
      ]
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'xybEventFilters' },
          levels.map(([key, label]) =>
            h(
              'button',
              {
                key: key || 'all',
                type: 'button',
                'aria-pressed': state.level === key,
                onClick: () => onLevel(key)
              },
              label
            )
          ),
          h('span', { className: 'xybHint', style: { marginLeft: 'auto' } }, state.status === 'loading' ? '读取中…' : `共 ${state.total} 条`),
          h('button', { type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, '刷新')
        ),
        state.error ? h('div', { className: 'xybError' }, state.error) : null,
        state.items.length === 0
          ? h('div', { className: 'xybEvents' }, h('div', { className: 'xybEventEmpty' }, '暂无事件。这个列表会显示启动、建档、核对与各类失败。'))
          : h(
              'div',
              { className: 'xybEvents' },
              state.items.map((item, index) =>
                h(
                  'div',
                  { className: 'xybEventRow', key: `${item.ts}-${index}` },
                  h('span', { className: 'xybEventTime' }, formatTime(item.ts)),
                  h('span', { className: 'xybEventLevel', 'data-level': item.level }, EVENT_LEVEL_LABELS[item.level] || item.level),
                  h(
                    'span',
                    { className: 'xybEventBody' },
                    item.message || '（无描述）',
                    h('span', { className: 'xybEventMeta' }, ` · ${item.phase}/${item.code}`)
                  )
                )
              )
            )
      )
    }

    /** 时间线里的时间给用户看（本地时间，秒级）。 */
    function formatTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function PageSettings({ textScale, onTextScale, onReopenWizard }) {
      const [state, setState] = React.useState({ status: 'loading', settings: null, storage: null, error: null, saving: false })
      const [events, setEvents] = React.useState({ status: 'loading', items: [], total: 0, level: '', error: null })
      const [diag, setDiag] = React.useState({ status: 'idle', info: '', preview: '' })
      const [selfcheck, setSelfcheck] = React.useState({ status: 'loading', items: [], summary: null, error: null, notice: null, busy: null })

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        Promise.all([api('/settings'), api('/storage/stats')])
          .then(([settings, storage]) => setState({ status: 'ready', settings, storage, error: null, saving: false }))
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [])

      React.useEffect(load, [load])

      /** 读事件时间线：级别筛选走查询串，服务端会校验级别取值。 */
      const loadEvents = React.useCallback((level = '') => {
        setEvents((s) => ({ ...s, status: 'loading', level, error: null }))
        api(`/events/list?limit=50${level ? `&level=${level}` : ''}`)
          .then((data) => setEvents({ status: 'ready', items: data.events || [], total: data.total || 0, level, error: null }))
          .catch((error) => setEvents({ status: 'error', items: [], total: 0, level, error: error.message }))
      }, [])

      React.useEffect(() => {
        loadEvents('')
      }, [loadEvents])

      /** 数据自检：先看有没有问题，再决定修不修。 */
      const loadSelfCheck = React.useCallback(() => {
        setSelfcheck((s) => ({ ...s, status: 'loading', error: null, notice: null }))
        api('/selfcheck')
          .then((data) =>
            setSelfcheck({ status: 'ready', items: data.items || [], summary: data.summary || null, error: null, notice: null, busy: null })
          )
          .catch((error) => setSelfcheck({ status: 'error', items: [], summary: null, error: error.message, notice: null, busy: null }))
      }, [])

      React.useEffect(() => {
        loadSelfCheck()
      }, [loadSelfCheck])

      /** 执行修复：拿回 after 复检结果直接刷新面板（不用再请求一次）。 */
      const repairSelfCheck = (action) => {
        setSelfcheck((s) => ({ ...s, busy: action, notice: null, error: null }))
        api('/selfcheck/repair', { method: 'POST', body: JSON.stringify({ action }) })
          .then((data) =>
            setSelfcheck((s) => ({
              status: 'ready',
              items: data.after?.items || s.items,
              summary: data.after?.summary || s.summary,
              error: null,
              notice: `已修复：${data.detail || action}${data.backup ? `（修复前备份：${String(data.backup).split(/[\\/]/).pop()}）` : ''}`,
              busy: null
            }))
          )
          .catch((error) => setSelfcheck((s) => ({ ...s, busy: null, error: `修复失败：${error.message}` })))
      }

      /** 导出前先取一次「将要导出什么」（透明性：让用户决定要不要交出去）。 */
      React.useEffect(() => {
        api('/diagnostics/preview')
          .then((data) => {
            const routes = data.preview?.routes?.length || 0
            const events = data.preview?.events?.items?.length || 0
            setDiag((current) => ({
              ...current,
              preview: `将包含：${routes} 条路由面、${events} 条事件、数据目录结构统计（共 ${routes + events} 项结构信息，已脱敏 ${data.redactions} 处）`
            }))
          })
          .catch(() => undefined)
      }, [])

      /** 导出诊断包：只写本机；返回路径 / 体积 / sha256 / 脱敏处数。 */
      const exportDiag = () => {
        setDiag({ status: 'busy', info: '' })
        api('/diagnostics/export', { method: 'POST' })
          .then((data) =>
            setDiag({
              status: 'done',
              info: `已导出到 ${data.path}（${Math.round(data.bytes / 1024)}KB，sha256 ${String(data.sha256).slice(0, 12)}…，脱敏 ${data.redactions} 处）`
            })
          )
          .catch((error) => setDiag({ status: 'error', info: `导出失败：${error.message}` }))
      }

      const save = (patch) => {
        setState((s) => ({ ...s, saving: true, error: null }))
        api('/settings', { method: 'POST', body: JSON.stringify(patch) })
          .then((settings) => setState((s) => ({ ...s, settings, saving: false })))
          .catch((error) => setState((s) => ({ ...s, saving: false, error: error.message })))
      }

      if (state.status === 'loading') return h('div', { className: 'xybLoading' }, '正在读取设置…')
      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'xybError' }, state.error),
          h('button', { type: 'button', className: 'xybBtn', style: { marginTop: 12 }, onClick: load }, '重试')
        )
      }

      const s = state.settings || {}
      const storage = state.storage || {}
      const cloudReady = Boolean(s.privacyAckAt)

      return h(
        'div',
        { className: 'xybSettings' },
        h(
          'section',
          { className: 'xybSetBlock' },
          h('h2', { className: 'xybSecTitle' }, '显示与可读性'),
          h(
            'div',
            { className: 'xybSetRow' },
            h(
              'span',
              null,
              h('span', { className: 'xybSetLabel' }, '界面大小'),
              h(
                'span',
                { className: 'xybSetDesc' },
                '中老年使用者建议「大字」或「特大」：文字与按钮一起变大，看得清也点得准。只影响本机显示，不改动任何数据。'
              )
            ),
            h(TextScaleControl, { scale: textScale, onChange: onTextScale, idPrefix: 'xyb-set-scale' })
          ),
          h(
            'div',
            { className: 'xybSetRow' },
            h(
              'span',
              null,
              h('span', { className: 'xybSetLabel' }, '首次设置向导'),
              h('span', { className: 'xybSetDesc' }, '重新走一遍「隐私说明 → 数据目录检测 → 界面大小 → 建立档案」。不会改动已有数据。')
            ),
            h('button', { type: 'button', className: 'xybBtn', onClick: onReopenWizard }, '重新打开向导')
          )
        ),
        // 模型与 API Key、青囊通道都放在**靠前**位置：用户反馈的第一件事就是「找不到入口」
        h(ModelSettingsSection, null),
        h(QingnangSettingsSection, null),
        h(
          'section',
          { className: 'xybSetBlock' },
          h('h2', { className: 'xybSecTitle' }, '数据自检'),
          h(
            'p',
            { className: 'xybHint' },
            '检查本机数据是否完好（目录可写、设置与档案清单能否读取、记录文件有没有坏行、临时文件残留、备份是否可用、磁盘余量）。发现问题会告诉你能不能一键修复。'
          ),
          h(SelfCheckPanel, { state: selfcheck, onCheck: loadSelfCheck, onRepair: repairSelfCheck })
        ),
        h(
          'section',
          { className: 'xybSetBlock' },
          h('h2', { className: 'xybSecTitle' }, '诊断与日志'),
          h(
            'p',
            { className: 'xybHint' },
            '这里记录本机发生的关键事件（含失败原因），方便你或开发者定位问题。内容只存在本机、不上传；记录里不含病历正文与患者标识。'
          ),
          h(EventTimeline, { state: events, onLevel: loadEvents, onRefresh: () => loadEvents(events.level) }),
          h(
            'div',
            { className: 'xybDiagRow' },
            h(
              'button',
              { type: 'button', className: 'xybBtn', disabled: diag.status === 'busy', onClick: exportDiag },
              diag.status === 'busy' ? '正在导出…' : '导出诊断包'
            ),
            h(
              'span',
              { className: 'xybDiagInfo' },
              diag.info ||
                diag.preview ||
                '导出包只写在本机：包含版本与运行环境、路由面、数据目录结构统计与已脱敏事件；不含病历正文、姓名与文档名。'
            )
          )
        ),
        h(
          'section',
          { className: 'xybSetBlock' },
          h('h2', { className: 'xybSecTitle' }, '关于'),
          h(
            'div',
            { className: 'xybAboutRow' },
            h(
              'a',
              {
                className: 'xybAboutLink',
                href: COMMUNITY_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: '小胰宝社区（GitHub）'
              },
              h('img', { className: 'xybAboutLogoXYB', src: XYB_LOGO_DATA_URI, alt: '小胰宝', draggable: false })
            ),
            h(
              'a',
              {
                className: 'xybAboutLink',
                href: NEXT_TEAM_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: 'DSH Desktop（DSH Next 团队）主页'
              },
              h('img', { className: 'xybAboutLogoDSH', src: DSH_LOCKUP_DATA_URI, alt: 'DSH Desktop', draggable: false })
            )
          ),
          h(
            'p',
            { className: 'xybAboutMeta' },
            h('strong', null, '小胰宝社区版'),
            '（社区发行版 · 非官方产品）—— 由小胰宝社区与 ',
            h('strong', null, 'DSH Desktop（DSH Next 团队）'),
            ' 联合发布。社区主页：',
            h(
              'a',
              { className: 'xybLink', href: COMMUNITY_URL, target: '_blank', rel: 'noopener noreferrer' },
              'github.com/PancrePal-xiaoyibao'
            ),
            ' · 上游项目主页：',
            h('a', { className: 'xybLink', href: NEXT_TEAM_URL, target: '_blank', rel: 'noopener noreferrer' }, 'dshdesktop.cn')
          ),
          h(
            'p',
            { className: 'xybAboutMeta' },
            '上游代码：',
            h('strong', null, 'DSH Desktop 开源项目'),
            '（',
            h('code', null, 'MIT License'),
            '，版权归 DataElement）。第三方组件与其许可文本随安装包一并提供。'
          ),
          h(
            'p',
            { className: 'xybAboutMeta' },
            '上游项目：',
            h('strong', null, 'DSH Desktop Next'),
            '（Anywhere Labs，',
            h('code', null, 'MIT License'),
            '，版权归 Anywhere Labs）—— 与本发行版联合发布；双方共同的上游是 ',
            h('strong', null, 'DeepSeek Harness'),
            '（',
            h('code', null, 'MIT License'),
            '，版权归 DeepSeek）。'
          ),
          h(
            'p',
            { className: 'xybAboutMeta' },
            '数据与病历保存在本机、不上传。本工作台不做诊断、不做处方、不解读量表，任何结论请以医生意见为准。'
          )
        ),
        h(
          'section',
          { className: 'xybSetBlock' },
          h('h2', { className: 'xybSecTitle' }, '数据来源'),
          h('p', { className: 'xybHint' }, '影响临床匹配的检索范围；不改变任何已保存数据。'),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', null, h('span', { className: 'xybSetLabel' }, '解析模式'),
              h('span', { className: 'xybSetDesc' }, cloudReady ? '云端解析已确认，可选 pipeline / vlm' : '隐私闸门未确认，本机解析（local）已强制生效')),
            h(
              'select',
              {
                'aria-label': '解析模式',
                value: s.parseMode || 'local',
                onChange: (e) => save({ parseMode: e.target.value })
              },
              ['local', 'cloud'].map((mode) =>
                h('option', { key: mode, value: mode, disabled: mode === 'cloud' && !cloudReady }, mode)
              )
            )
          ),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', null, h('span', { className: 'xybSetLabel' }, '解析管线'),
              h('span', { className: 'xybSetDesc' }, '决定扫描件与图片能否被识别；仅在云端解析可用时生效')),
            h(
              'select',
              {
                'aria-label': '解析管线',
                value: s.parseModel || 'pipeline',
                disabled: !cloudReady,
                onChange: (e) => save({ parseModel: e.target.value })
              },
              ['pipeline', 'vlm'].map((m) => h('option', { key: m, value: m }, m))
            )
          )
        ),
        h('section',
            { className: 'xybSetBlock' },
            h('h2', { className: 'xybSecTitle' }, '存储与备份'),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', null, h('span', { className: 'xybSetLabel' }, '数据目录'),
              h('span', { className: 'xybSetDesc' }, s.dataRootOverride || '默认（应用数据目录下的 xyb/）')),
            h('span', { className: 'xybHint' }, `已用 ${formatBytes(storage.total)}`)
          ),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', null, h('span', { className: 'xybSetLabel' }, '备份 / 还原'),
              h('span', { className: 'xybSetDesc' }, '当前版本尚未提供一键备份；现在可手动复制上面的目录。')),
            h('button', { type: 'button', className: 'xybBtn', disabled: true }, '未实现')
          ),
          h(
            'div',
            { className: 'xybSetRow' },
            h('span', null, h('span', { className: 'xybSetLabel' }, '资料占用明细'),
              h('span', { className: 'xybSetDesc' },
                `记录 ${formatBytes(storage.records)} · 文档 ${formatBytes(storage.documents)} · 派生 ${formatBytes(storage.derived)} · 其他 ${formatBytes(storage.other)}`)),
            null
          )
        ),
        h('p', { className: 'xybDisclaimer' },
          '以上设置全部保存在本机，不会上传。云端解析仅在你在设置中确认隐私闸门后才会用于你显式选中的文件。'),
        state.error ? h('div', { className: 'xybError', style: { marginTop: 12 } }, state.error) : null,
        state.saving ? h('p', { className: 'xybHint', style: { marginTop: 8 } }, '正在保存…') : null
      )
    }

    //
    // customFrame 是宿主的官方能力（workbench-standard.zh.md §3.5 / §4）：
    // · 宿主把主内容区交给本组件，并**把原生会话作为 `conversation` 节点传入**；
    // · 规范要求：「原生会话由宿主提供的 conversation 节点放进业务布局，
    // 不能再创建一套聊天界面」——所以聊天区直接渲染该节点，不自造聊天。
    // · 不得覆盖 Desktop 左侧会话栏（那是宿主保留的公共入口）。
    // ─────────────────────────────── 界面大小（中老年可读性）
    const TEXT_SCALE_KEY = 'xyb:text-scale:v1'
    const TEXT_SCALES = [
      ['normal', '标准'],
      ['large', '大字'],
      ['xlarge', '特大']
    ]

    /** 读取上次选择的界面大小（取值不合法就回到标准）。 */
    function readTextScale() {
      try {
        const saved = window.localStorage.getItem(TEXT_SCALE_KEY)
        return TEXT_SCALES.some(([key]) => key === saved) ? saved : 'normal'
      } catch {
        return 'normal' // 无 localStorage（隐私模式等）：不阻断使用，只是记不住偏好
      }
    }

    /** 记住界面大小；写失败不影响本次生效（仅下次打开回到标准）。 */
    function persistTextScale(scale) {
      try {
        window.localStorage.setItem(TEXT_SCALE_KEY, scale)
      } catch {
        /* 忽略：偏好持久化失败不应打断使用 */
      }
    }

    /**
     * 界面大小三档控：标准 / 大字 / 特大。
     *
     * 为什么用三档分段控而不是「一个开关」：中老年使用者能**直接看到**可选大小，
     * 一次点击到位，无需猜测“再点一下会变成什么”；当前档位有 aria-pressed 与选中底色。
     */
    function TextScaleControl({ scale, onChange, idPrefix }) {
      return h(
        'div',
        { className: 'xybTextScale', role: 'group', 'aria-label': '界面大小' },
        TEXT_SCALES.map(([key, label]) =>
          h(
            'button',
            {
              key,
              id: `${idPrefix}-${key}`,
              type: 'button',
              'aria-pressed': scale === key,
              title: key === 'normal' ? '标准大小' : `放大界面（${label}）：文字与按钮一起变大`,
              onClick: () => onChange(key)
            },
            label
          )
        )
      )
    }

    /** 右侧「AI 协助」开关：null = 跟随会话数（有会话才展开），true/false = 用户显式选择 */
    const CHAT_PREF_KEY = 'xyb:chat-open:v1'
    function readChatPref() {
      try {
        const raw = window.localStorage.getItem(CHAT_PREF_KEY)
        if (raw === '1') return true
        if (raw === '0') return false
      } catch {
        /* 无 localStorage（测试沙箱 / 隐私模式）：跟随会话数 */
      }
      return null
    }
    function persistChatPref(open) {
      try {
        window.localStorage.setItem(CHAT_PREF_KEY, open ? '1' : '0')
      } catch {
        /* 存不下不影响本次开关 */
      }
    }

    function XybFrame({ service, conversation }) {
      React.useLayoutEffect(ensureStyles)
      const [tab, setTab] = React.useState('dash')
      const [view, setView] = React.useState('pages') // pages | settings
      const [chatPref, setChatPref] = React.useState(readChatPref)
      const [textScale, setTextScale] = React.useState(readTextScale)
      const changeTextScale = (scale) => {
        setTextScale(scale)
        persistTextScale(scale)
      }
      const [state, setState] = React.useState({
        status: 'loading',
        patients: [],
        active: null,
        error: null,
        creating: false
      })

      const loadPatients = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api('/manifest')
          .then((data) => {
            const patients = data.patients || []
            setState((s) => ({
              ...s,
              status: 'ready',
              patients,
              active: s.active && patients.some((p) => p.id === s.active.id) ? s.active : patients[0] || null
            }))
          })
          .catch((error) => setState((s) => ({ ...s, status: 'error', error: error.message })))
      }, [])

      React.useEffect(loadPatients, [loadPatients])

      // ── 首次设置向导：读设置决定要不要弹；完成后写回 onboarding 标记
      const [settings, setSettings] = React.useState(null)
      const [wizard, setWizard] = React.useState({ open: false, busy: false, error: null })

      React.useEffect(() => {
        api('/settings')
          .then((data) => {
            setSettings(data)
            const onboarding = data?.onboarding || {}
            setWizard((w) => ({ ...w, open: !onboarding.done && !onboarding.skipped }))
          })
          .catch(() => undefined) // 读不到设置就不弹向导（不能因此拦着用户用应用）
      }, [])

      const saveOnboarding = (patch, onOk) => {
        setWizard((w) => ({ ...w, busy: true, error: null }))
        api('/settings', {
          method: 'POST',
          body: JSON.stringify({ onboarding: { ...(settings?.onboarding || {}), ...patch, at: new Date().toISOString() } })
        })
          .then((data) => {
            setSettings(data)
            setWizard({ open: false, busy: false, error: null })
            if (onOk) onOk()
          })
          .catch((error) => setWizard((w) => ({ ...w, busy: false, error: error.message })))
      }

      /** 向导最后一步：先建档，再标记完成（建档失败就不关向导，把错误显示在向导里）。 */
      const finishWizard = (name) => {
        setWizard((w) => ({ ...w, busy: true, error: null }))
        api('/patients', { method: 'POST', body: JSON.stringify({ name }) })
          .then((profile) => {
            setState((s) => ({ ...s, patients: [...s.patients, profile], active: profile }))
            saveOnboarding({ done: true, skipped: false })
          })
          .catch((error) => setWizard((w) => ({ ...w, busy: false, error: error.message })))
      }

      const createPatient = (name) => {
        setState((s) => ({ ...s, creating: true, error: null }))
        api('/patients', { method: 'POST', body: JSON.stringify({ name }) })
          .then((profile) => {
            setState((s) => ({ ...s, creating: false, patients: [...s.patients, profile], active: profile }))
          })
          .catch((error) => setState((s) => ({ ...s, creating: false, error: error.message })))
      }

      /** 没有会话时，给一个明确的开始入口（复用宿主自己的工作台会话流程）。 */
      const startSession = () => {
        if (!service || typeof service.newWorkspaceSession !== 'function') return
        const task = service.newWorkspaceSession()
        if (typeof service.run === 'function') service.run(task)
        else if (task && typeof task.catch === 'function') task.catch(() => {})
      }

      // 本工作台名下是否已有会话（宿主在无会话时会把 conversation 节点隐藏）
      let ownedSessions = 0
      try {
        const snap = service && typeof service.getSnapshot === 'function' ? service.getSnapshot() : null
        const bindings = snap && snap.state ? snap.state.sessionBindings || {} : {}
        ownedSessions = Object.values(bindings).filter((owner) => repoKey(owner) === repoKey(REPOSITORY)).length
      } catch {
        ownedSessions = 0
      }

      // 默认展开条件：本工作台名下**真的有会话**。
      // 没有会话时右侧面板只有一行提示、剩下整列空白 —— 用户实测把这当成「界面只显示左半边」。
      const chatOpen = chatPref === null ? ownedSessions > 0 : chatPref
      const toggleChat = () => {
        const next = !chatOpen
        setChatPref(next)
        persistChatPref(next)
      }
      const closeChat = () => {
        setChatPref(false)
        persistChatPref(false)
      }

      if (state.status === 'loading') return h('div', { className: 'xybRoot' }, h('div', { className: 'xybLoading' }, '正在启动…'))

      if (state.status === 'error') {
        return h(
          'div',
          { className: 'xybRoot' },
          h(
            'div',
            { className: 'xybBody' },
            h('div', { className: 'xybError' }, state.error),
            h('button', { type: 'button', className: 'xybRow', style: { marginTop: 12 }, onClick: loadPatients }, '重试')
          )
        )
      }

      const page =
        tab === 'dash'
          ? state.active
            ? h(Board, {
                patient: state.active,
                onChanged: loadPatients,
                onNavigate: (page) => {
                  setView('pages')
                  setTab(page)
                }
              })
            : h(FirstRun, { onCreate: createPatient, busy: state.creating, error: state.error })
          : tab === 'records' && state.active
            ? h(PageRecords, { patient: state.active, onChanged: loadPatients })
            : tab === 'timeline' && state.active
              ? h(PageTimeline, { patient: state.active })
              : tab === 'psych'
                ? h(PagePsych, { patient: state.active })
                : tab === 'nutrition' && state.active
                  ? h(PageNutrition, { patient: state.active })
                  : tab === 'match' && state.active
                    ? h(PageMatch, { patient: state.active })
                    : tab === 'care' && state.active
                      ? h(PageCare, { patient: state.active })
                      : h(TabPlaceholder, { tabKey: tab })

      return h(
        'div',
        { className: 'xybShell', 'data-text-scale': textScale },
        h(
          'header',
          { className: 'xybTop' },
          h(
            'div',
            { className: 'xybBrand' },
            h(
              'a',
              {
                className: 'xybBrandLink',
                href: COMMUNITY_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: '小胰宝社区（GitHub）',
                'aria-label': '小胰宝社区（GitHub）'
              },
              h('img', {
                className: 'xybBrandLogo',
                src: XYB_LOGO_DATA_URI,
                alt: '',
                'aria-hidden': 'true',
                draggable: false
              })
            ),
            PRODUCT
          ),
          h('div', { className: 'xybTopSpacer' }),
          state.patients.length > 0
            ? h(
                'label',
                { className: 'xybPicker' },
                '当前档案',
                h(
                  'select',
                  {
                    value: state.active ? state.active.id : '',
                    'aria-label': '当前患者档案',
                    onChange: (e) => {
                      const id = e.target.value
                      const picked = state.patients.find((p) => p.id === id) || null
                      setState((s) => ({ ...s, active: picked }))
                    }
                  },
                  state.patients.map((p) => h('option', { key: p.id, value: p.id }, p.name))
                )
              )
            : null,
          h('span', { className: 'xybLocal' }, h('i', null), '资料留在本机'),
          h(TextScaleControl, { scale: textScale, onChange: changeTextScale, idPrefix: 'xyb-top-scale' }),
          h(
            'button',
            {
              type: 'button',
              className: 'xybTopBtn',
              'data-on': view === 'settings' ? 'true' : 'false',
              'aria-pressed': view === 'settings',
              onClick: () => setView((v) => (v === 'settings' ? 'pages' : 'settings'))
            },
            '设置'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'xybTopBtn',
              'data-on': chatOpen ? 'true' : 'false',
              'aria-pressed': chatOpen,
              onClick: toggleChat
            },
            'AI 协助'
          )
        ),
        h(
          'nav',
          { className: 'xybTabs', role: 'tablist', 'aria-label': '主要任务' },
          TABS.map((entry, index) =>
            h(
              'button',
              {
                key: entry.key,
                id: `xyb-tab-${entry.key}`,
                type: 'button',
                className: 'xybTab',
                role: 'tab',
                'aria-selected': view === 'pages' && tab === entry.key,
                'aria-controls': 'xyb-panel',
                tabIndex: view === 'pages' && tab === entry.key ? 0 : -1,
                onClick: () => {
                  setView('pages')
                  setTab(entry.key)
                },
                onKeyDown: (e) => {
                  // 页签键盘导航（WAI-ARIA tabs）：←/→ 切换并移动焦点，Home/End 到首尾
                  const keys = TABS.map((t) => t.key)
                  const current = keys.indexOf(entry.key)
                  let next = null
                  if (e.key === 'ArrowRight') next = keys[(current + 1) % keys.length]
                  else if (e.key === 'ArrowLeft') next = keys[(current - 1 + keys.length) % keys.length]
                  else if (e.key === 'Home') next = keys[0]
                  else if (e.key === 'End') next = keys[keys.length - 1]
                  if (!next) return
                  e.preventDefault()
                  setView('pages')
                  setTab(next)
                  const node = document.getElementById(`xyb-tab-${next}`)
                  if (node && typeof node.focus === 'function') node.focus()
                }
              },
              h('span', { className: 'xybTabNum' }, String(index + 1)),
              entry.label
            )
          )
        ),
        h(
          'div',
          { className: 'xybMain' },
          h(
            'main',
            {
              className: 'xybPage',
              id: 'xyb-panel',
              role: 'tabpanel',
              'aria-labelledby': view === 'pages' ? `xyb-tab-${tab}` : undefined,
              'aria-label': view === 'settings' ? '设置' : undefined
            },
            view === 'settings' ? h(PageSettings, { textScale, onTextScale: changeTextScale, onReopenWizard: () => setWizard({ open: true, busy: false, error: null }) }) : page
          ),
          h(
            'aside',
            { className: 'xybChat', 'data-open': chatOpen ? 'true' : 'false', 'aria-label': 'AI 协助' },
            h(
              'div',
              { className: 'xybChatHead' },
              h('span', null, 'AI 协助 · 会话由宿主提供'),
              h(
                'button',
                { type: 'button', className: 'xybTopBtn', onClick: closeChat },
                '收起'
              )
            ),
            // 品牌条放在面板顶部（对话区域会占满剩余高度，放底部会被挤到可视区之外——实测）
            h(BrandStrip),
            h(
              'div',
              { className: 'xybChatBody' },
              ownedSessions === 0
                ? h(
                    'div',
                    { className: 'xybChatEmpty' },
                    h('p', null, '还没有会话。新建一个工作区即可开始对话；会话会自动关联小胰宝工作台。'),
                    h(
                      'button',
                      { type: 'button', className: 'xybBtn xybBtn--primary', onClick: startSession },
                      '新建工作区并开始对话'
                    )
                  )
                : null,
              h('div', { className: 'xybChatMount' }, conversation || null)
            )
          ),
          // 首次设置向导：覆盖层放在最后，首次使用或从设置页手动打开时显示
          wizard.open
            ? h(OnboardingWizard, {
                dataRoot: settings?.dataRoot || '',
                textScale,
                onTextScale: changeTextScale,
                onFinish: finishWizard,
                onSkip: () => saveOnboarding({ done: false, skipped: true }),
                busy: wizard.busy,
                error: wizard.error
              })
            : null
        )
      )
    }

    // ─────────────────────────────── 宿主侧栏收尾（V-1101）
    //
    // 宿主外壳的布局是 grid「<侧栏宽> 1fr 0」（实测 264px 1fr 0）：禁用侧栏插件只会
    // 让列内容消失，**轨道宽度仍在** → 左侧留一条 264px 空白（实测， 收尾）。
    // 这里在“侧栏列存在且无可见子节点”时注入一条 CSS 把第一轨收为 0；
    // 选择器用 CSS Module 的**语义后缀**（_sidebarCol），不用构建期哈希。
    const HOST_SIDEBAR_STYLE_ID = 'xyb-host-sidebar-collapse'
    // ⚠️ 不要给侧栏列 display:none（真实事故，2026-10-17）：列被移出 grid 流后，
    // 后续列会被**自动排进第 1 轨**（0px）→ 中间列宽度归 0 → 整个界面白屏（实测：
    // centerCol/customFrame 宽度 0，DOM 文本都在但不可见）。
    // 正确做法：只收轨道宽度，并用 grid-column 显式钉住各列位置。
    const HOST_SIDEBAR_CSS =
      'div:has(> [class*="_sidebarCol"]){grid-template-columns:0 1fr 0 !important}' +
      '[class*="_sidebarCol"]{grid-column:1 !important;overflow:hidden !important;min-width:0 !important}' +
      '[class*="_centerCol"]{grid-column:2 !important;min-width:0 !important}'

    /**
     * 侧栏列里是否存在“真内容”（可见盒子 / 文本 / 可交互元素）。
     *
     * ⚠️ 不能用 childElementCount 判断（实测 CDP，2026-10-17）：禁用侧栏插件后，
     * 列里仍留着一个空槽位锚点 <div data-slot="sidebar" style="display:contents">，
     * childCount=1、innerText=''、0×0、可交互元素 0 —— 旧判据因此永远不收轨道。
     */
    function hasVisibleSidebarContent(column) {
      if (column.querySelectorAll('button,a,input,select,textarea,img,svg,video,canvas').length > 0) return true
      if (typeof column.innerText === 'string' && column.innerText.trim() !== '') return true
      const nodes = column.querySelectorAll('*')
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i]
        const style = getComputedStyle(el)
        if (style.display === 'contents') continue // 槽位锚点：不占空间
        if (style.position === 'fixed') continue // 浮层锚点
        const rect = el.getBoundingClientRect()
        if (rect.width > 2 && rect.height > 2) return true
      }
      return false
    }

    /** 注入一次；返回是否已处理（注入成功或确认无需处理）。 */
    function collapseEmptyHostSidebar() {
      try {
        if (!document || typeof document.querySelector !== 'function') return true
        if (document.getElementById(HOST_SIDEBAR_STYLE_ID)) return true
        const column = document.querySelector('[class*="_sidebarCol"]')
        if (!column) return false // 还没渲染出来：等下一轮
        // 只有“被禁用而空”的侧栏列才收：有内容的场景不去动它（其他发行版/用户自开）
        if (hasVisibleSidebarContent(column)) return true
        const style = document.createElement('style')
        style.id = HOST_SIDEBAR_STYLE_ID
        style.textContent = HOST_SIDEBAR_CSS
        document.head.appendChild(style)
        return true
      } catch {
        return true // DOM 异常不影响插件
      }
    }

    // ─────────────────────────────── 双品牌条（上游 + 社区）
    //
    // 资产与 dsh-xyb-branding 同源（那里注入宿主 slots；侧栏隐藏后那些槽位不可见）。
    // 为避免两个插件互相 require，这里内联同一份资产；修改时两处同步。
    // ─────────────────────────────── 社区品牌资产（来源：仓库 assets/）
    // · XYB_LOGO_DATA_URI：小胰宝吉祥物。构建期不做图像处理，故在开发期用 Python(PIL) 完成
    // 白底→透明 + 边缘羽化 + 定尺 144px，再内联为 WebP data URI（10.7KB，3x 屏清晰）。
    // · DSH_LOCKUP_DATA_URI：上游官方锁定标（深色板 + 白字），直接内联原始 JPEG 字节
    // （零重编码损失，15.2KB）；不要抠底 —— 抠底会毁掉白字。
    const XYB_LOGO_DATA_URI =
      'data:image/webp;base64,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'
    // 品牌外链（M12-4）：走标准 <a href> —— 宿主 src/main/security.ts 的
    // setWindowOpenHandler / will-navigate 会把 http(s) 链接交给系统浏览器打开，
    // 因此不需要也不得自造任何 IPC。
    const COMMUNITY_URL = 'https://github.com/PancrePal-xiaoyibao'
    const NEXT_TEAM_URL = 'https://www.dshdesktop.cn/'
    const DSH_LOCKUP_DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//gAXR2VuZXJhdGVkIGJ5IFNuaXBhc3Rl/9sAhAAKBwcIBwYKCAgICwoKCw4YEA4NDQ4dFRYRGCMfJSQiHyIhJis3LyYpNCkhIjBBMTQ5Oz4+PiUuRElDPEg3PT47AQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCACMAosDAREAAhEBAxEB/8QBogAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoLEAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+foBAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKCxEAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzGtiAoAKAFpAFABQAUAFABQAUALQAUAFABQAUAFABQAUAFABQAUALQAUAFABQAUAFABQAUAFABQAUAFAC0AFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAlABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFADKACmAUAFIBaACgAoAKACgAoAKAFoAKACgAoAKACgAoAKACgAoAKAFoAKACgAoAKACgAoAKACgAoAKAFoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKAEoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKAGUAFABTAKQC0CCgYUAFABQAUAFMApALQAUAFABQAUAFABQAUAFABQAUwFpAFABQAUAFABQAUAFABQAUALQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAUAFABQAlABQAUAFABQAUAFABQAUAFABQAUAMoAKAFVWdgqqWZjgADJJpgbFv4P8AEtyoaLQdQKnoTbsoP5ildBYs/wDCAeLP+gFdfkP8aV0Fg/4QDxZ/0Arr/vkf40XQWYf8IB4s/wCgFdf98j/Gi6Cwf8IB4s/6AV1/3yP8aLoLDJPAviqJctoN6f8Adj3fyougsZd7pWo6a+y/sLm1b0miZP5imBVpgFABSAWgAoAKACgAoAKACgAoAKYBQAtIAoAKACgAoAKACgAoAKACgBaACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoASgAoAKACgAoAKACgAoAKACgBlAG/wCD/CN74u1X7Lb5it48NcXBXKxr/UnsP6A0m7Ake42ei+G/AOizXsVssMdvHmW4Yb5X/H3J6DA5qLtlbEvhrxlpHimzubqxaSNbU/vlnUKyDkgnBPBwfyoasFyDw54+0PxRqM9jp7TiaJSw82PaJFBwWXk8cjrg89KGrBcS2+IGg3Xil/Dsck32pZGiDlMRs4zlQc5zwR0x6UWdrhc6ekMKACgBksUc0bRSxrIjDDKwyCPcUAcJ4q+FGkaxE9xpCJp17ycIP3Uh9Cv8P1H5GqUhWPE9Q0+70q+lsb6BoLiFtro3b/Ee9WSVqYBSAWgAoAKACgAoAKACgApgFAC0gCgAoAKACgAoAKACgAoAKAFoAKBBQMKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKAEoAKACgAoAKACgAoAKACgBlAH0Z8PPDyeHvCVrGyAXN0onuD33MOB+AwPrn1rNu7KRvalptrq+nTafexebbzrtdckZH1FIZm+HfCGkeF7Oe20+JytyQZWlbcz4GAPpyfzNNu4WM7Q/C/hPwjqE97aXEcc8qlMz3Kny1JyVUce3XJ4obbEVYNF8BWHih9fTU7JLxnaQI16mxXOcsFJ68n2HbFO7sGh0f/AAk/h/8A6Dum/wDgXH/jSsxkia/oshAj1excnptuUP8AWlYC1FeWs/8AqbmKT/ccH+VAE1ABQB5z8X/DMeoaGNchXFzYYEmB9+InH6E5+maqLEzxKtCQpALQAUAFABQAUAFABQAUwCgD27w18NvC2peGtNvrmwdp7i2SSQidwCxGTxms23cqxp/8Kp8H/wDQPk/8CZP8aXMwsRSfCTwk+dttcR5H8Nw3H55p8zCxi6n8E7F4ydK1WeKTstyodT7ZUDH5GjmCx5t4h8K6v4YuRFqdttRjiOZDujk+h/ocGqTuSY9MAoA9L8IfCSXUraO/16WS1hkG5LaPiRh6sT936dfpUuQ0jv7b4c+EbVNqaNE/qZXZyfzNTdjsQah8L/Cd8jBdONq5HElvIykfgSV/SjmYWPLPGnw9v/Ch+1RubvT2bAmC4aM9gw/r/KrTuS0chTEesfD3wJ4e1/wrHf6jaPLcNK6lhM68A8cA1LbuUkYfxR8LaR4Zn01NKt2hFwshk3SM+cFcdT7miLuDODqhBQB6N8MPCGi+JbG+l1W2aZoZVVCsrLgEexqW7DSLfxJ8E6D4c8PRXmmWrxTNcKhYys3GD2J9qE2waPLqoQUAFAHs3hD4d+GdW8K6ff3lk73E8W52E7jJyewNQ27lJGz/AMKp8If9A+T/AMCJP8aXMwsiOT4S+EnzttbiPj+G4b+uaOZhZGRqPwU02SMnTdUuYJOoE4WRfpwAR+tPmCx5x4k8Haz4WlA1C3BhY4S4iO6Nvx7H2OKpO5NjCpgFABQAUAFABQAUAFABQAUAFABQB734G8OaFd+DNMuLnRdPnmeHLSSWqMzHJ6kjJrNvUpHn/wAWtOsdN8SW0VhZ29pG1sGKQRKgJ3HnAFVETOEqhBQAUAFAGovhjxAyhl0LUiCMgi0k5/SldAZro0bsjqVZThlIwQfSmA2gAoAKACgAoAKACgAoAKACgAoAKACgC74esF1TxFp1hICY7i6jjfH90sM/pmhgfURIAyTgCsizwvxj8UtV1S/lttFupLHT42Kq8R2yS/7RbqB6AY96tRJbOIudRvr3/j7vLi4yc/vZWb+ZqhFemAUAFABSAWgC3bavqdn/AMeuo3UH/XKZl/kaAO98E/FTUbXUYrHX7k3VnKwQTuBvhPYkgfMPXPNS4jTPYNSs49S0q6snAZLmFoz/AMCBFQUfK5BBwRgitiApALQAUAFABQAUAFABQAUwCgD6X8Gf8iXo3/XlF/6CKye5aPP/AIj+N/Eeg+K2sdM1HyLcQowTyY25Oc8spNUkrEtnN2/xY8XwtmS+huBnpJboB/46BT5UFzsfC/xhhvrlLTXraO0dzhbmEny8/wC0DyPrk/hUuI7noWpabZa1p0llewrPbzLyD+hB7H3qRnzl4q8PzeGdfn02UlkU7onI++h6H+n4Vqncg0PhxpMWseNLOGdQ0UOZmUjg7eg/PFJ7DR9B3VxHZ2c1zJ9yGMu2PQDNZlHgOs/EvxLql68sGoSWUGf3cMB27R7nqTWiiibnTfD34k6pcazDpGtT/ao7k7IpmADo3YEjqD+dJoEz1XULGDUrCeyuUDwzoUZT6GoKPl+/tTY6hc2hOTBK0ZPrtJH9K1IPc/hH/wAiJD/13k/nUS3KWxzHxw/4+tH/ANyb+aU4iZ5ZVCCgD2H4Jf8AIM1T/rsn/oNRIaL3xl/5FKD/AK+1/wDQWojuNniFWSFABQB9G/D7/kRdK/64/wBTWb3KRyPxN8Y6/wCHtft7XSr/AOzwvbh2XyY3yckZyyn0ppJibORg+K3i+JsvqEU4z0kt4wP/AB0Cq5UF2dZ4c+Mi3Fwltr9pHAHOBc2+dq/7ynJx7g/hUuIXPSrq1s9W097e4jjubW4TkHlWB7//AF6ko+ePGnhl/C3iCWyGWt3HmW7nuh7H3HStE7kM5+mAUAFABQAUAFABQAUAFABQAUAfRvw+/wCRF0r/AK4/1NZvcpHm3xn/AORptf8Ar0H/AKEaqImed1QgoAKAJ7OH7TfQQYz5sip+ZxQB9TRoI4lQdFUCsiz5e1f/AJDV9/18Sf8AoRrUgp0AFABQAUAFABQAUAFABQAUAFABQAUAdH8NY1l+IOkq4yBI7fiEYj9RSlsC3PdvFc7WvhHV5kOGSylKn0Ow4qFuWz5irQgKACmAUAFABSAWgAoAKAPqbRZJJtDsJZjmR7aNnPqSozWTLPm1dP8AtfisaYcjzr7yDtPIy+3itehBu+MvhzqfheSS5gV7zTOonUZaMejgdPr0+nSkncbRx1MRb07StQ1e4Fvp1nNdSn+GJC2Pc+g9zQBe8ReFtR8LyWsWp+Us1zF5nlxvuKDOMN2z9Mj3pJ3Ax6YBQAUAFABTAKAPpfwZ/wAiXo3/AF5Rf+gisnuWjyH4vf8AI8v/ANe0f9auOxLOHpiCgD334V61Jq3g+OOZy8tk5gJPUqBlf0OPwqJblIwfjZpqtZadqar86SGFiPQjI/UH86IgzjvhhqUOmeN7Vp2CJcK0G49AW6fqBVPYSPfrm3ju7WW2lGY5UKMPYjBrMo8D8S/DXXdCnke3tnv7IHKTQLuYD/aUcj+VaJomxySPLbzB42eKWM5DKSGUj+VMRf8A+Ei1z/oM6h/4FP8A40WQGe7vLI0kjs7uSWZjkknqSaAPePhH/wAiJD/13k/nUS3KWxzPxw/4+tH/ANyb+aU4iZ5ZVCCgD2H4Jf8AIM1T/rsn/oNRIaL3xl/5FKD/AK+1/k1Edxs8QqyQoAKAPo34ff8AIi6V/wBcf6ms3uUjzb4z/wDI02v/AF6D/wBCNVHYTPO6oQUAe5fCDWZNQ8MSWMzFnsJNiEn+AjI/LkVEikVvjPpqT+HrXUQo8y2n2E4/hYdPzAoiDPFqsk9T8EfCqO8tY9T8QhwkgDRWgJUkernqPoKlyGkenWeiaRpseyz021t1H9yJRn6nvUXKGX/h/RtVjKXumWtwD3aIZH0PUfhTuB5T47+GH9jW8mq6IXktE5lt2O5oh6g9x9eRVJktHm9UI7v4efD8eJy2oaizpp0TbQqHDTN3GewHrUt2Gkew2WgaFosH+i6dZ2qKOX8tQfxY8n8TU3KJJtM0bVoMTWVleRf7UauKQHl3xD+GtvpdnJrOhoyQR83FsSTsH95Seceoq0yWjzCqEfRvw+/5EXSv+uP9TWb3KR5t8Z/+Rptf+vQf+hGqjsJmb8P/AANL4pv/ALTdqyaZA37xunmn+4P6mm3YEj1zUdC8H6Pp0t7e6LpcUEK5ZmtU/Lpyai7HoeD+I9Xt9Z1aS4s9OttPtR8sUMESphfVsDkmrRJ7t4f8M6D/AGLptydFsPP8iN/M+zJu3YBznGc571DZR0lIZkv4V8OyyNJJoWnO7klma1Qkk9zxTuwseNfFbT7LTfFscFhaQWsRtEYpDGEXO5ucD6VUdiWYPhrw3feKNVWxslA43Syt92NfU/4U27CPb9B+HHhzQ4VzZJfXAHzT3ShyT7KeB/P3qG2VY6M2NmY/LNrCUxjaYxj8qQzl/EPwz8Pa3CxgtU0+5/hltlCjPuo4P8/emmxWPENf0C+8N6rJp9+gDryrL9117MPatFqSM0GKObxDpsUqLJG93ErIwyGBcZBHpQwPoeTwf4beJ0Gg6apZSARaoCP0rO7Lsct4Q+FWnabF9q1uFL26Y5WF+Y4x2yOjH68U2xJHdx6fZQxCKKzgSMDARYlA/LFSM5/Xvh54d12BgbGOzuD92e2UIwPuBw34002Kx4d4l8N33hfVnsL0Z/iilUfLIvqP8O1WnckyKYHTfC9wnxE0on1lH5xOKUtgW57Z44Qv4I1kD/n0c/kM1C3KZ801oQFMYUAFABQAUALSEFAwoA+qtOiMGmWsLDaY4UUjGMYUCsiz5v16STTPHGozRH95balI6H3WQkH9K1WxB9FaPq9l4g0iHULNxJBOvKnBKnurD1HpWWxZwup/COxvPF8N3B+50mQGS5gRsEOCPlX0DZ/DB6cVXNoKx31hp1ho9ktrY20Vrbxj7qDA+pPc+5qRnz/8RPEMPiTxZNdWx3W0Ci3hf++qknd9CSSPatErIlnMUxBQIKBhQAUwCgD6X8Gf8iXo3/XlF/6CKye5aPIfi/8A8jy//XtH/WrjsSzh6YgoA9g+CDN/Z+qr/CJUI+uDUSKRr/GAA+CSSORcx4/WiO4M8JBKkEEgjkEVZJ6l4S+L32aCOx8RRvIqAKt3GMtj/bXv9R+VS49hpnpuleINI1uPfpuo29zxkqj/ADD6r1H4ipsUQ6x4V0PXlI1LTYJnIx5oXbIP+BDmi7QHlnjH4Tz6Rbyahoksl3bICzwOP3iD1BH3h+v1qlIlo85qiT3n4R/8iJD/ANd5P51Ety1sdjPbWs5BuIYpCOnmKDj86kZF/Z+m/wDPna/9+l/woAP7P03/AJ87X/v0v+FAE0FvbwA/Z4YowevlqBn8qAOD+Mv/ACKUH/X2v8mqo7iZ4hVkhQAUAfRvw+/5EXSv+uP9TWb3KR5t8Z/+Rptf+vQf+hGqjsJnndUIKAPU/ggzfa9XXnb5cR/HLVMho6z4rAHwBe+0kX/oYqY7jex5V8ONDj1zxhbxzrugtwZ5ARwdvQfmRVt6Eo921zVotC0S61KYZS3jLBf7x7D8TWaLPnPXfEeqeIrxrnUbp5MnKRA4SMeir2rS1iCx4Z8V6n4Y1COe0ncwbh5tuT8kg78evvQ1cLn0bDJDf2KSgB4biMNg8gqw/wDr1mWfN3i3SV0PxRf6egIjilJj/wB08j9DWiIZ7h8N/J/4QPTPJ242Nux/e3HP61D3KWxyXxc0PxBqF7b3VpDPd6dHHjyoQW8t8nJKjnkY59qcWhM888OeIb7wrrKXlvv+Q4mgLFRIvdT/APq4qmriO6uvjSLu1ltpfDqlJUKMDediMf3KXKO55d9KoR9GfD7/AJEXSv8Arj/U1m9ykcv408I3Xizx/aQJmO0itVa5m/urubge5pp2QNanewQad4d0cRRiO1srSPqTgKB1JNTuM8L8eeOJ/Fd/5UBaLTYG/cxnguf7ze/p6VolYhs5GmB0OheItcOs6dAdZ1DyTcRJ5f2p9u3cBjGemO1JoD6PrMs+cda8S6/FruoRx65qKIlzIqqt24AAY4AGa0sQYt5fXmoTCa9u57qUDbvmkLtj0yaYHvHwy0KPR/CNvMUxcXw8+ViOcH7o/AfzrNvUpGV8UfG91oQi0nS5fKup03yyj70adAB6E8800gbPIV1jVFuftS6ldifOfN85t2frnNWSe0fDHxpceJLKax1Fw97aAHzMYMqHufcHr+FQ1YpMT4taFHqPhY6iqD7RYMHDdyhOGH8j+FEXqDPHPDn/ACM2lf8AX5D/AOhirZJ9P1kWeQ/En4hX8epy6Jo1w1tHB8s88Zw7N3UHsB7VaRLZ53FrerQXH2mLU7tJs5MgnbJ+pzVWEez/AA08cTeJbaWw1Jgb+2UN5gGPNTpnHqO9Q1YpMn+Kehx6r4Rmugo8+w/fI3fb/EPy/lRF6gzwOrJNvwHcra+OdHlY4BuVTrj73y/1oewI+h9atWvtC1CzQZa4tZIwPdlI/rWSLPlkgg4IwRWpmFMAoAKBhQAUAFABSA0NBsW1PX9PsVBP2i4RDjsCwyfwGTQwPqSsizwb4seHrjTfFU2pLGxtL/EgcDhXxhlJ9eM/jWkXoSzL8Cax4gsNft7XQ2eRrmQCS3IyjjuT6YH8XbFDsCPfdd1i30DRbrVLkZjt03bQcFz0Cj6kgVC1KPD/ABV8TtZ8S2z2UaJp9k+d8cTEtIPRm7j2AGe+atRsS2cZTELTAKACkAUAFMAoA+l/Bn/Il6N/15Rf+gisnuWjyH4v/wDI8v8A9e0f9auOxLOHpiCgD3L4PaY9n4Tku5FIN7OXXP8AdAwP1zUS3KRU+NV+sWhWNgGG+ecyEd9qj/EiiIM8jstK1HUt/wBgsLq72fe8iFn2/XA4qySW50DWbKBp7rSL63hX70kts6qPqSKLgUUd4nWSN2R1OQynBBpgd14R+KGraTdxW2rXD31gxCsZTmSMeobqfoalxGme5qyyIGUhlYZB9RWZR86eP9Ki0bxlf20C7IWYSoo7BhnH55rRbEM9X+Ef/IiQ/wDXeT+dTLcpbHMfHD/j60f/AHJv5pTiJnllUSFAz2H4Jf8AIM1T/rsn/oNRIaL3xl/5FKD/AK+1/k1Edxs8QqyQoAKAPo34ff8AIi6V/wBcf6ms3uUjzb4z/wDI02v/AF6D/wBCNVHYTPO6oQUAez/BfTHg0S91F1x9qlCIfVV/+uT+VRIpFr4xXyW/hGO0J+e6uFAHsvJ/pRHcGc18Ewv9s6kT94W64/765pyEj1nUr6x06ya51GaOG2UgM8n3Rk4H61BRi/8ACZeDf+gtp/6f4U7MV0H/AAmXg3/oLaf+n+FFmF0Sjx14UUADXLMAdAHoswueM/EfUbHVfGNxd6fOk8LRoPMQ5BIHNWtiWSeCfH954SZrd4vtVhI25od2Ch9VP9O/tQ1cEz1fS/iX4V1RVH9oraSEcx3Q8vH/AAL7v61FmVc25bTRtftw8sFlqMJ6MVSUfgeaQzifFHwk0u7tZLjQlNndKCwh3Exye3PKn6ce1UpCseMSRvDK8UilXRirKeoI6irJPor4ff8AIi6V/wBcf6ms3uUjVGrWY1ttJZwl2YRMqn+NckcfTH60hnO/ErQNS1/w4Y9NnfdA3mPbDGJwO31HUCmmJngLKVYqwIYHBBHIrQkSgC9oP/Iw6b/19xf+hikwPqGsyz5e17/kYdS/6+5f/QzWqIKFAH1Ho2z+xLHy8bPs8eMem0VkWeH/ABXLnx3c7s4EUe36ba0jsS9zjKYjvfg6WHjRwCdptH3fmtTLYaPV/Gu3/hCtY3dPscn544qVuNnz74d/5GbS/wDr8h/9DFaMk+nayLPl3WS51y/Mn3zcybvruOa1IKVAHb/CMsPHMW3ODbybsemB/wDWqZbDR7N4kCnw1qYbG37LJnP+6alFHzFWhA/T7s2GpWt4vJt5klH/AAEg/wBKAPqmGZLiCOaJtySKGU+oIyKyLPnr4jeGpPDvimfZGws7tjNbtjjk5ZfwP6Y9a0TuiGjlKoQUAFABQMKACgApAen/AAb8MSz6k/iK4Rlhtg0dsTxvcjDH6AEj6n2NTJ9Bo9lqCiC7s7W/tntry3juIX4aOVQyn8DQBW0zQNI0ZnbTdNtrVn4ZoowGI9M9ce1O4Hm/xp8QL5dp4fhbLEi4uMdhyEH8z+AqorqSzySqEFAgpjFoAKQBQAUwCgD6X8Gf8iXo3/XlF/6CKye5aPLPirpGp3vjR5rTTru4j+zxjfFAzDPPcCqjsSzkI/C/iCU4j0PUWOccWr/4VV0I67wz8I9Xv7lJtbX7BaA5ZNwMrj0AH3fqfyqXIdj2eKK10uwWKMJb2ttHgDoqKBUFHz74/wDEw8T+JJLiFibSAeVb57qOrfif6VolYlm98GtVitPEV1p8rBTexDyye7KScfkT+VKQI9a8Q6QmvaDd6Y7bPtEZVW/ut1B/OpWhR846zoOp6BeNa6laSQuDhWI+V/dT0IrS9yCXw94b1LxJqEdrY27upYCSXb8kY7knpQ3YD6Xt4Rb20UKnIjQKPwGKyLPnr4jalHqfje/lhYNHERCrA9dowf1zWi2IZ6n8I/8AkRIf+u8n86mW5S2OY+OH/H1o/wDuTfzSnETPLKokKAPYfgl/yDNU/wCuyf8AoNRIpF74y/8AIpQf9fa/yaiO42eIVZIUAFAH0b8Pv+RF0r/rj/U1m9ykcB8XdK1G+8S20lnYXNwgtQC0ULOAdx4yBVREzhU8M6/IcJoeosfa1f8Awp3EdR4d+E+uancI+qx/2daZy28gyMPQKOn4/rSch2ParGytdI06KztUWG2t02qM9AO5NQUeE/EnxTH4k8Q7bV91lZgxxMOjn+Jvx/pWiViGxPhjrcejeMIfPcJDdqYGJ6An7p/MAfjRJaAj3DXtJi13RLvTJTtW4jKhv7p7H8DUIs+ctb0HUvD989pqNs8TAkK5HyyD1U9xWidyCx4Y8L6h4o1OO1tIX8ncPOn2/LEvck+voKG7Akekv8FtIijaSTWLpVUEsSq4AqOYdjyO9S3jvZktHaSBXIjd+rLngmrEet6V8JfDWqaVa38eoaiVuIlk4kjxyP8AcqOZjscN468GS+E9U2wiaXT5QDDO4zzjlSQAM5/SqTuJoz/Ck+qw+IrMaO8wuXlUbYyfmGeQw7jHXNNgj6WGcc9ayLPmfxY0T+LNVaHHlm6kxjp945rRbEHu3w+/5EXSv+uP9TUPcpHn3xZvrnTPG2n3tnKYp4bdWRx2O41UdhM9E8HeK7XxXo63UeEuY8LcQ55RvX6HtUtWGjivif4B8wSeINIh+f713Cg6/wC2B/P86aYmjyWrEXNGkWHW7CVzhUuY2J9gwoA+ogQRkdDWRZ88eKfCWvWviO//AOJVdzRyTvJHLFCzqwYkjkD3rRMho525tLmyl8q7t5beTGdkqFTj1waYHvnw01uPWPB9tHvzPZDyJQTzx90/iMVm1qUjD+Kvgq71gxa1pcJmnhTZPCgyzqOhHqRzxTiwaPH0tLmS5+zJbytPnb5QQls+mOtWSe2fC/wZc+HrObUdSj8u8ugFWI9Y068+5NQ2UkSfFrW49O8KtYK4+0X7BAvfYDlj/IfjRFagzxvw7/yM2l/9fkP/AKGKtkn09WRZ438SvAN+mqza3pVs9zb3B3zRxLlo27nA6g9eOlWmS0ecwWlzc3AtoLeWWYnAjRCzZ+g5qhHtXwx8EXHh6GXU9TQJe3C7Ei6mJOvPuePyqGyki/8AFDW49J8H3EG4effDyI1zzg/eP5fzpJagzwCtCSKmI9/+FfiMa54VjtZXzd6diFwepT+BvyGPqprOS1LRv+JfDWn+KdKewv094pVHzRN6j/DvSTsM8H8UeAtb8MTuZrdrmzz8l1CpK47bv7p+v4ZrRNMho5qmIsWNhdanexWdlA89xK21I0HJNAzuovgt4je28x7rT45MZERkYn6EhcfzqeZDscZrOiahoGoNY6lbtDMoyM8hh6g9xTTuIoAEnAGSaYHoHg/4ValrEiXeso9hYgg+WwxLKPQD+Ee5/AVLkOx7bZWVtp1nFZ2cKwwQqFjjXoorMonoAKAMvxF4gsfDWkS6jfOAqcJGD80r9lX3P6DJ7U0rgfNmr6pca1q1zqV2czXMhdsdB6AewGAPpWhBToAKBBTAKBi0gCgApgFAH0J4S8S6BbeEdJgn1zTopY7SNXje7jVlIUZBBPBrJp3KRr/8JZ4b/wChh0v/AMDI/wDGizHcD4t8NgZ/4SDS/wALyP8AxoswuZGp/FDwppqNtvzeSDpHbIWz/wAC4X9aOViueXeMPiRqXihGtIU+xaeTzCrZaT/eP9P51aViWzjaoRLbXM1ncx3NvI0U0TBkdTgqR0NIZ7R4U+LOmahBHba64sbwDBlI/dSe+f4T9ePeocSrnd295ZahCHtrmC5ib+KNw6n8qkYXN/YadD5l1d29tGv8UkioB+dAHnHjX4r2sdtLp/h2QzTOCr3eMKg77fU+/T61Sj3JbPHySxJJJJ5JNWSe1fC/XtG0/wAGRW97q1jbTCaQmOa5RGwTxwTmoktS0c98YtV07U7nSjp9/bXgjSXebeZZNuSuM4PHSnETPNqokKAPVfg/rGl6Zp2opqGpWlozzKVE86xlhjtk81MikXfixrekal4XhhsdUsrqQXKsUguEdgMHnANKIM8eqxBQIKAPevA3iPQrTwZplvc61p8EyQ4aOS6RWU5PUE5FQ1qWjf8A+Er8N/8AQwaX/wCBkf8AjSsx3EPizw2B/wAjBpf/AIGR/wCNFmFzL1L4l+FNOU/8TIXTgZCWyl8/j939aLMVzzLxh8TtQ8RxPY2UZsbBuGUNl5R/tHsPYfmatRsJs4imSAJByDgigD1vwT8VrcWsWm+IpDG8YCx3mCQw7B/Q+9S49ikz0m2vtP1OASWt1b3cR6GN1cfpUFDb3VdL0iDzL29trSMf89HC/kO9AHk3j74nLq9vJpOhl1tX4muCCplHoo6gfXrVpEtnm1USd/8AD74jDw7H/Zeqh5LAtmORRloSevHde/rUtXKTPXrLWNG1y3/0S+tLyNhygcN+a9R+IqSiWODStKR5Y4rSyXHzOqrGPxPFIDivGfxR03T7KWz0S4W8vXBUSx8xxe+ehP0qlETZ4mzM7FmJLMcknuask958DeI9CtPBmmW9zrWnwTJDho5LpFZTk9QTkVDWpSPP/i1qNjqXiS2lsLy3u41tgpeCVXAO48ZBpxEznPDPiK78MazFqFqxKg4lizxIncGqauI97s/Gnhq+sorj+2rCISqCY5rhEdfYqTkVnZlXPIPiFoeiWl9/aWgapY3FvcN+8t4LlHaJvUAHO0/pVpiZxlMR7N4L+KWmTabBYa7P9luoVCCdwSkoHQkjofXPFQ4lJnZDxZ4bIz/wkGmfjeR/40rMdzxr4q39nqPi8T2N3BdRfZkXzIJA65y3GRVx2JZj+FfFN74U1UXlr88bDbNCTgSL/j6Ghq4j3HQfHnh7X4UMF9HBOetvcMEcH0GeD+GahplXOgLxhd5dQP72aQzmPEXxF8P6BC4F2l7dD7sFuwY5/wBojhf5+1NJiueG+IfEF74l1aTUL5vmbhIx92NeyitErEjfDn/IzaX/ANfkP/oYoYH09WRZxXh74kaVfTzafqlxHZXsErR7pTtjlAJAIboD7H8KpoVzskmikQOkiMh5DKwINSMwdf8AHOgeHoXNxfRzTqOLaBg8hPuB0/HFNJsVzwvxT4nvfFWrG9u8IijbDCp4jX09z6mrSsSYtMCGmBreGfEd54W1mPUrPaxUFZI2+7Ih6g/4+opNXA+iPDnibTfFGmpeafMCcDzISRviPow/r3rNqxZr0gMHUvBHhnVmLXejWxc9XjXy2P1K4zTuxWI9A8CaD4Z1CS+02CRJpI/L+eQsFXIJxn6ChtsLHRUhmL4i8J6R4oW3XVIXkFuxZNjlTyOQSO3T8qadgsGkeD/D2hENp2lQRSDpKw3uP+BNkii7CxtUgCgAoA5zxP460TwshS7n827xlbWHlz6Z/uj6/rTSuK54V4p8W6n4r1A3F7JthQnyLdT8kQPp6n1Pf9K0SsTcxKYBQAUgCmIKAFpAFABTGFABQAUALQAUgCmIKACgYUAFABQAtIAoEFABQAUAFABQAUDFoEFABQAUAFABQAUAFABQAUAFABQAUDCgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKANHw5/yM2l/wDX5D/6GKGB9PVkWfLmr/8AIavv+viT/wBCNakFOgAoAKACgCCmAtAFrTtTvdIvFvNPuZLadOjocfgfUexpAeh6R8bNTt02atp0N5jpJE3lN+IwQfwxU8o7nTQfGnw3Iv7621CFu4MasP0alysdyz/wt/wn/wA9rr/vwaOVhdB/wt/wn/z2uv8AvwaOVhdB/wALf8J/89rr/vwaOVhdAfjB4TAyJbs+wgP+NHKwuV5fjR4ZQHZb6jIR0xEoB/NqOVhcyLz44ptZbHQ2LfwvPPgD6qB/WnyiucjrHxO8UaxE0LXq2kL5ylquwkem773601FCuckSWYsxJJOST3qhBQAUAFAwoAKBBQAtIAoAKYBQAUDCgAoAKAFoEFABQMKACgAoAWkAUCCgAoAKACgAoAWgAoAKACgAoAKACgAoAKACgAoAKACgAoGFABQAUAFABQIKACgAoAKBhTAKACgAoAKACgAoAKACgAoAKACgDR8OkDxLpZJwBeQ5J/3xSewH0z9qt/8AnvH/AN9isiz5g1cg6zfEcj7RJ/6Ea1IKlMAoAKACgCCgBaACgAoEFABQAtABQAUAFABQMKAFoEFABQAUDCgAoAKBC0AFIApgFABQAUDCgAoAWgQUAFAwoAKACgBaQBQIKACgAoAKACgAoAWgAoAKACgAoAKACgAoAKACgAoAKACgYUAFABQAUCCgAoAKACgAoAKBhTAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgCCgQUDFoAKACgQUALQAUAFABQAUAFAxaBBQAUAFAwoAKACgQUAFAC0AFABQAUAFAwoAWgQUAFABQAUDCgBaQBQIKACgAoAKACgAoAKAFoAKACgAoAKACgAoAKYBQAUAFABQMKACkAUCCgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgYUwCgAoAgoEFABQMWgAoEFABQAtABQAUAFABQMKAFoEFABQAUDCgAoAKBBQAtABQAUAFABQMKAFoEFABQAUAFAwoAKAFpAFAgoAKACmAUgCgAoAKAFoAKACgApgFABQAUAFABQAUAFIYUAFAgoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgYUAFAEFMQUAFAC0AFABQAUAFAC0AFABQAUDCgAoAWgQUAFABQMKACgQUALQAUAFABQAUDCgBaBBQAUAFABQMKACgAoAWkAUCCmAUAFIAoAKACgBaACgApgFABQAUAFABQAUgCgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKAP/2Q=='

    const DSH_MARK_VIEWBOX = '0 0 1000 1000'
    const DSH_MARK_PATH =
      'M478.318 218C605.318 218 683.318 287 687.318 404L691.318 472C693.318 525 697.319 556 726.318 574C746.318 587 774.318 585 790.318 562C799.318 550 802.318 539 792.318 534C747.319 513 727.318 472 738.318 428C739.652 420 742.652 418.667 747.318 424C774.318 450 815.318 460 831.318 501C855.318 457 898.318 456 930.318 436C936.318 431.333 939.318 433.333 939.318 442C938.318 496 903.318 535 850.318 547C841.318 570 833.318 592 819.318 622C773.318 723 661.318 782 491.318 782H294.318C161.319 782 74.3183 714 53.3184 592C41.3184 526 38.3184 433 50.3184 375C70.3184 277 113.82 218 234.32 218H478.318ZM571.82 350.5C469.82 333.5 277.82 329.5 164.82 350.5C138.82 355.5 114.318 379 110.318 404C100.318 451 102.318 551 124.318 596C155.318 660 214.319 697 315.318 705C324.318 678 346.319 662 376.318 662C404.318 662 427.318 678 435.318 705C493.318 699 526.318 680 562.318 652C621.318 606 633.749 527.103 633.749 424C633.749 385.144 604.82 355.5 571.82 350.5Z'

    /**
     * 品牌与许可署名（AI 协助面板顶部）。
     *
     * 设计（taste：主基因=瑞士平面严格层级；辅基因=中国画留白，只点「气口」一层）：
     * · 主品牌在上：吉祥物 32px + 「小胰宝」字标 + 「社区发行版」标签 —— 一眼可辨
     * · 上游在下：官方锁定标 26px（自带深色板，不抠底以免毁掉白字）+ 许可与版权
     * · 两组之间用一条极细分隔线留出气口，不用背景块堆叠
     * 尺寸说明：社区开发者反馈「logo 太小」→ 图标由 14px 符号升到 26–32px 实图。
     */
    function BrandStrip() {
      return h(
        'footer',
        { className: 'xybBrandStrip', 'aria-label': '品牌与许可归属' },
        h(
          'div',
          { className: 'xybBrandRow' },
          h(
            'a',
            {
              className: 'xybBrandLink',
              href: COMMUNITY_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: '小胰宝社区（GitHub）',
              'aria-label': '小胰宝社区（GitHub）'
            },
            h('img', {
              className: 'xybBrandRowLogo',
              src: XYB_LOGO_DATA_URI,
              alt: '',
              'aria-hidden': 'true',
              draggable: false
            }),
            h('strong', null, PRODUCT),
            h('span', { className: 'xybTag' }, '社区发行版 · 非官方产品')
          )
        ),
        h('div', { className: 'xybBrandDivider', 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'xybBrandRow' },
          h(
            'a',
            {
              className: 'xybLockupLink',
              href: NEXT_TEAM_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: 'DSH Desktop（DSH Next 团队）主页',
              'aria-label': 'DSH Desktop（DSH Next 团队）主页'
            },
            h('img', { className: 'xybBrandLockup', src: DSH_LOCKUP_DATA_URI, alt: 'DSH Desktop', draggable: false })
          ),
          h('span', null, 'DSH Desktop 系列 · MIT License · Copyright (c) 2026 DataElement')
        ),
        h('p', { className: 'xybBrandNote' }, '第三方组件与其许可文本随安装包一并提供。')
      )
    }

    // ─────────────────────────────── 插件入口
    const REPOSITORY = 'https://github.com/PancrePal-xiaoyibao/dsh-desktop-xiaoyibao'

    /**
     * 默认入口（打开即小胰宝面板）。
     *
     * 宿主的工作台状态里 active 默认是 null → 打开时落在宿主会话页；
     * 首次运行时把本工作台设为激活，此后打开就是业务面板（+ 工作台会话）。
     * 走宿主的官方客户端 API（desktopWorkbenches.open），不写宿主文件、不改宿主代码；
     * 只做一次（localStorage 标记），用户之后自行切换工作台/退出时不再干预。
     */
    const DEFAULT_ENTRY_MARK = 'xyb:default-entry:v1'
    const repoKey = (url) =>
      String(url || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
    const defaultEntryApplied = () => {
      try {
        return window.localStorage.getItem(DEFAULT_ENTRY_MARK) === '1'
      } catch {
        return false
      }
    }
    const markDefaultEntryApplied = () => {
      try {
        window.localStorage.setItem(DEFAULT_ENTRY_MARK, '1')
      } catch {
        // 无存储（测试/受限环境）时忽略：下次启动会再试一次，无副作用
      }
    }

    /** 返回一个「尝试激活」函数；宿主服务面不满足时返回 null（测试替身保持可用）。 */
    function createDefaultEntryAttempt(service) {
      if (!service || typeof service.getSnapshot !== 'function' || typeof service.subscribe !== 'function') return null
      let called = false
      return () => {
        if (called) return
        const snap = service.getSnapshot()
        if (!snap || !snap.ready) return
        if (snap.state && snap.state.active) {
          // 用户（或旧安装）已有选择 → 不干预，只记标记
          markDefaultEntryApplied()
          return
        }
        const catalog =
          service.catalog instanceof Map
            ? [...service.catalog.values()]
            : Array.isArray(service.catalog)
              ? service.catalog
              : []
        const self = catalog.find((item) => item && repoKey(item.repository) === repoKey(REPOSITORY))
        if (!self || !self.id) return
        called = true
        Promise.resolve(service.open(self.id)).then(
          () => markDefaultEntryApplied(),
          () => {
            called = false // 宿主稍后就绪（或用户开启工作台功能）后允许重试
          }
        )
      }
    }

    function apply(ctx) {
      ctx.effect(() =>
        ctx.desktopWorkbenches.register(
          {
            title: PRODUCT,
            repository: REPOSITORY,
            description: '胰腺癌患者全程管理：病历整理、指标趋势、临床匹配、营养与心理支持。数据留在本机。',
            category: '健康',
            // customFrame：接管主内容区，把宿主传入的原生会话（conversation）嵌进业务布局 ——
            // 打开即原型 v2 的完整界面（顶栏 + 7 页签 + 主区 + AI 协助）
            customFrame: true,
            layout: { businessSide: 'right', businessWidth: 0.36 }
          },
          XybFrame
        )
      )

      // 默认入口：首次运行把本工作台设为激活（面板即首屏）
      ctx.effect(() => {
        if (defaultEntryApplied()) return () => {}
        const attempt = createDefaultEntryAttempt(ctx.desktopWorkbenches)
        if (!attempt) return () => {}
        const off = ctx.desktopWorkbenches.subscribe(attempt)
        attempt()
        return () => {
          if (typeof off === 'function') off()
        }
      })

      // V-1101 收尾：宿主外壳侧栏被禁用后仍保留 264px 轨道 → 空列时注入 CSS 收掉。
      // 重试是为了等外壳挂载完成；一旦处理完（注入或确认有内容）就停。
      ctx.effect(() => {
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          if (collapseEmptyHostSidebar() || tries >= 20) clearInterval(timer)
        }, 800)
        collapseEmptyHostSidebar()
        return () => clearInterval(timer)
      })
    }

    return {
      apply,
      inject: ['desktopWorkbenches'],
      // 供测试复用
      _views: { XybFrame, XybPanel: XybFrame, Board, FirstRun }
    }
  }
})
