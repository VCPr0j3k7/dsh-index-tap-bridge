/**
 * dsh-index-tap-bridge —— 把 `webServer.tapIndex` 的 HTML 变换翻译成结构化注入行。
 *
 * ## 为什么需要它
 *
 * `@deepseek-ai/dsh-host-webserver` 提供两条往 index.html 里塞东西的通道：
 *
 *   1. **结构化注入行**（一等公民）：插件订阅 `webserver/index-inject`，
 *      往表里 push `{ kind: 'script-src' | 'script' | 'style' | 'html' | ... }`。
 *      `collectIndexInjections()` 把它取出来。
 *   2. **`tapIndex(transform)`**（逃生舱）：注册一个 html → html 的纯函数，
 *      由 `renderIndex()` 在**渲染完结构化行之后**依次调用。
 *
 * 官方源码对第 2 条的注释是"the escape hatch for markup no IndexInjection row
 * expresses"，而 `renderIndex()` 只在 **Host 自己的 fallback 渲染 index 时**被调用。
 *
 * 官方 Harness 桌面版（Electron 外壳）**不渲染 Host 的 index.html**：窗口加载的是
 * 外壳自带的 `dsh-web-frontend/dist/index.html`（自定义 scheme `dsh-app://app/`），
 * Host 只在 boot 完成后被问一次 `collectIndexInjections()`，外壳按行的 kind 注入。
 * 源码里写得很直白 —— "Electron uses file:// plus IPC instead"。
 *
 * 于是 `tapIndex` 这条通道在桌面版里是**死的**：变换函数注册成功、不报任何错，
 * 但永远不会被调用。表现就是「插件在插件列表里是启用状态，注入的脚本却从未被加载」。
 *
 * ## 它做什么
 *
 * 在 `webserver/index-inject` 发射的那一刻（此时所有插件都已加载、tap 都已注册），
 * 把每个 tapIndex 变换跑在一份最小骨架 HTML 上，取出它**新增**的标记，
 * 翻译成官方注入行推进表里。原变换一个字节都不改，原插件的代码不用动。
 *
 * 只在官方桌面外壳里启用（见 `isDesktopShell`），所以浏览器 / `dsh web` 的行为
 * 完全不变 —— 那边 `renderIndex()` 会照旧调用 tapIndex，不需要也不该重复注入。
 */

/** Loader 身份。 */
export const name = 'index-tap-bridge'

/** 只依赖 webServer：注入行的发射与 tap 的存放都在它身上。 */
export const inject = ['webServer']

/**
 * 探测骨架。
 *
 * 必须与官方 `dsh-web-frontend/dist/index.html` 同构到变换在意的程度：
 * 有 `<head>`、有 `<body>`、body 里有内容位。tapIndex 变换基本都是字符串插入
 * （`replace('</body>', tag + '</body>')` 这一类），这份骨架足够它们正常返回。
 */
const PROBE = '<!doctype html><html><head></head><body></body></html>'

/**
 * 扫描 head / body 里的元素。
 *
 * `script` / `style` 要连内容一起吃掉（否则内联正文会被当成新标记）；
 * 其余元素只吃开标签。
 */
const ELEMENT_RE =
  /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<([a-z][a-z0-9-]*)\b[^>]*\/?>/gi

/**
 * 允许走 `html` 行的普通元素（放行清单，宁可少放不可乱放）。
 *
 * `<script>` 绝不允许落进这一支：`insertAdjacentHTML` 插入的脚本不会执行。
 */
const HTML_ROW_TAGS = new Set(['div', 'span', 'template', 'noscript', 'iframe', 'meta', 'link'])

/**
 * 本进程是不是官方桌面外壳的 Host。
 *
 * 判据取 `process.argv`：外壳用
 * `spawn(node, ['--expose-internals', <runtime>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js, runtimeDir, projectDir, ...])`
 * 起 Host，所以入口脚本路径里必然带着 `dsh-desktop-host`。这是唯一能区分
 * 「Host 的 index 会不会被渲染」的可靠信号 —— 用 Electron/`--expose-internals`
 * 之类的特征都会把 VC 那套自包含外壳（它自己加载 Host URL，走的是 renderIndex 那条路）
 * 一起误判进来。
 *
 * `DSH_INDEX_TAP_BRIDGE=on|off` 可强制覆盖，方便排查。
 * @returns {boolean} 是否启用桥接
 */
function isDesktopShell() {
  const forced = process.env.DSH_INDEX_TAP_BRIDGE
  if (forced === 'on' || forced === '1' || forced === 'force') return true
  if (forced === 'off' || forced === '0') return false
  return process.argv.slice(0, 2).some((arg) => arg.includes('dsh-desktop-host'))
}

/**
 * 取出一个元素的某个属性值（只做够用的解析：引号包裹，大小写不敏感）。
 * @param {string} markup 元素原始标记
 * @param {string} attribute 属性名
 * @returns {string|undefined} 属性值
 */
function attribute(markup, attribute) {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(markup)
  if (match === null) return undefined
  const value = match[2] ?? match[3] ?? match[4] ?? ''
  return value.trim() === '' ? undefined : value
}

/** 元素名（小写）。 */
function tagName(markup) {
  const match = /^<\s*([a-z][a-z0-9-]*)/i.exec(markup)
  return match === null ? '' : match[1].toLowerCase()
}

/** 元素的内联内容（`<script src>` 这类空元素返回空串）。 */
function innerMarkup(markup) {
  const open = markup.indexOf('>')
  const close = markup.lastIndexOf('</')
  if (open === -1 || close === -1 || close <= open) return ''
  return markup.slice(open + 1, close)
}

/**
 * 把一段新增标记翻译成官方注入行。
 * @param {string} markup 元素原始标记
 * @param {string} tag 元素名（小写）
 * @param {'head'|'body'} placement 它出现在哪一段里
 * @returns {object|undefined} 注入行；无法表达时返回 undefined
 */
function toRow(markup, tag, placement) {
  if (tag === 'script') {
    const src = attribute(markup, 'src')
    if (src !== undefined) return { kind: 'script-src', src }
    const text = innerMarkup(markup)
    if (text.trim() === '') return undefined
    return { kind: 'script', text, placement }
  }

  if (tag === 'style') {
    const text = innerMarkup(markup)
    return text.trim() === '' ? undefined : { kind: 'style', text }
  }

  if (HTML_ROW_TAGS.has(tag)) {
    // `<link>` 只对 head 有意义；其余按原位置走。
    return { kind: 'html', placement: tag === 'link' ? 'head' : placement, html: markup }
  }

  return undefined
}

/** 行的去重键（同 kind 同载荷只推一次）。 */
function rowKey(row) {
  return [row.kind, row.src ?? '', row.text ?? '', row.html ?? '', row.placement ?? ''].join('\u0000')
}

/**
 * 取一个区块（head / body）的**内部** HTML。区块缺失时返回空串。
 * @param {string} html 完整 HTML
 * @param {string} tag 区块名
 * @returns {string} 内部 HTML
 */
function section(html, tag) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html)
  if (open === null) return ''
  const start = open.index + open[0].length
  const close = html.toLowerCase().indexOf(`</${tag}`, start)
  return close === -1 ? html.slice(start) : html.slice(start, close)
}

/**
 * 找出 `out` 相对骨架**新增**的元素，并翻译成注入行。
 *
 * 骨架的 head/body 都是空的，所以区块内部的内容就是新增标记；
 * 这里仍逐条对照骨架（`PROBE.includes`），是为了将来换用非空骨架时行为不会悄悄变。
 *
 * @param {string} out 变换后的 HTML
 * @returns {{ rows: object[], unrecognized: string[], outside: boolean }} 注入行、翻不出来的标记、是否改了骨架之外
 */
function translate(out) {
  const rows = []
  const unrecognized = []

  for (const [tag, placement] of [
    ['head', 'head'],
    ['body', 'body'],
  ]) {
    const inner = section(out, tag)
    if (inner === '') continue
    ELEMENT_RE.lastIndex = 0
    for (const match of inner.matchAll(ELEMENT_RE)) {
      const markup = match[0]
      if (PROBE.includes(markup)) continue
      const name = match[1] === undefined ? tagName(markup) : match[1].toLowerCase()
      const row = toRow(markup, name, placement)
      if (row === undefined) {
        unrecognized.push(markup.slice(0, 120))
        continue
      }
      rows.push(row)
    }
  }

  return {
    rows,
    unrecognized,
    // 变了、但 head/body 里什么都没多出来 —— 说明变换动的是骨架本身，桥接翻译不了。
    outside: out !== PROBE && rows.length === 0 && unrecognized.length === 0,
  }
}

/**
 * Cordis 插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主根上下文
 */
export function apply(ctx) {
  if (!isDesktopShell()) {
    ctx.logger?.debug?.('index-tap-bridge: 非官方桌面外壳，不启用（tapIndex 通道在那边本身可用）')
    return
  }

  ctx.on('webserver/index-inject', (table) => {
    const taps = ctx.webServer?.indexTaps
    if (!Array.isArray(taps) || taps.length === 0) return

    const seen = new Set(table.map(rowKey))
    for (const transform of taps) {
      let out
      try {
        out = transform(PROBE)
      } catch (error) {
        ctx.logger?.warn?.(`index-tap-bridge: tapIndex 变换在探测骨架上抛错，已跳过：${error?.message ?? error}`)
        continue
      }
      if (typeof out !== 'string' || out === PROBE) continue

      const { rows, unrecognized, outside } = translate(out)
      for (const markup of unrecognized) {
        ctx.logger?.warn?.(`index-tap-bridge: 无法翻译成注入行，已忽略：${markup}`)
      }
      if (outside) {
        ctx.logger?.warn?.('index-tap-bridge: 该 tapIndex 变换改的是骨架本身而非新增标记，桌面版无法翻译')
      }
      for (const row of rows) {
        const key = rowKey(row)
        if (seen.has(key)) continue
        seen.add(key)
        table.push(row)
      }
    }
  })

  ctx.logger?.info?.('index-tap-bridge: 已启用（tapIndex → webserver/index-inject 翻译）')
}

/*
 * 以下导出只为验证脚本（`_check.mjs`）使用，不是插件接口的一部分。
 * 插件接口只有上面的 `name` / `inject` / `apply`。
 */
export { isDesktopShell as _isDesktopShell, translate as _translate, toRow as _toRow, PROBE as _PROBE }
