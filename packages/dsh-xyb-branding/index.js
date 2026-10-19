/**
 * dsh-xyb-branding — 小胰宝社区版品牌层（服务端）
 *
 * 本插件不做服务端工作：品牌的呈现完全在客户端（见 client.js）。
 * 这里只需提供合法的 `apply` 入口，供 cordis.patch.yml 的 insert 行加载。
 *
 * 参照上游同类做法（dsh-desktop-client-ui/index.js）：纯客户端插件的服务端入口可以是空 apply。
 */

/**
 * 服务端入口。无服务端行为。
 * @param {object} _ctx Cordis 上下文（本插件不使用）
 * @param {object} _config 插件配置（本插件不使用）
 */
export function apply(_ctx, _config) {
  // 品牌注入由 client.js 通过 slots 完成；服务端无需注册任何路由或服务。
}

/** 本插件不依赖任何宿主服务 */
export const inject = []
