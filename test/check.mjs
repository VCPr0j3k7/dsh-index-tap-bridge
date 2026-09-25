/**
 * 桥接逻辑的自检（不依赖 DSH 运行时，纯 Node 跑）。
 *
 *   node test/check.mjs
 *   npm test
 */
import { _translate as translate, _toRow as toRow, _PROBE as PROBE, _isDesktopShell as isDesktopShell } from '../index.js'

let pass = 0
let fail = 0
const ok = (label, condition) => {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}`)
  }
}

console.log('1) 鲸鱼挂件那种注入（body 前插 script src）')
{
  const tap = (html) => html.replace('</body>', '<script defer src="/dsh-whale/widget.js"></script></body>')
  const { rows, unrecognized } = translate(tap(PROBE))
  ok('翻出恰好一行', rows.length === 1)
  ok('kind = script-src', rows[0]?.kind === 'script-src')
  ok('src 正确（defer 不影响）', rows[0]?.src === '/dsh-whale/widget.js')
  ok('没有翻不出来的标记', unrecognized.length === 0)
}

console.log('2) head 内联脚本')
{
  const tap = (html) => html.replace('<head>', '<head><script>globalThis.X=1</script>')
  const { rows } = translate(tap(PROBE))
  ok('kind = script', rows[0]?.kind === 'script')
  ok('placement = head', rows[0]?.placement === 'head')
  ok('内联正文完整', rows[0]?.text === 'globalThis.X=1')
}

console.log('3) style / link')
{
  const tap = (html) => html.replace('<head>', '<head><style>.a{color:red}</style><link rel="stylesheet" href="/x.css">')
  const { rows } = translate(tap(PROBE))
  ok('style 行', rows.some((r) => r.kind === 'style' && r.text === '.a{color:red}'))
  ok('link 走 html 行且固定在 head', rows.some((r) => r.kind === 'html' && r.placement === 'head' && r.html.includes('/x.css')))
}

console.log('4) 空 src / 空 style 不产生行')
{
  ok('script src="" 丢弃', toRow('<script src=""></script>', 'script', 'body') === undefined)
  ok('script 无内容丢弃', toRow('<script></script>', 'script', 'body') === undefined)
  ok('style 空丢弃', toRow('<style>  </style>', 'style', 'head') === undefined)
}

console.log('5) 未改动 HTML → 零行；翻不出来的标记要报出来')
{
  const noop = (html) => html
  ok('恒等变换零行', translate(noop(PROBE)).rows.length === 0)
  const weird = (html) => html.replace('</body>', '<canvas id="c"></canvas></body>')
  const { rows, unrecognized } = translate(weird(PROBE))
  ok('canvas 不硬塞（避免 insertAdjacentHTML 语义错）', rows.length === 0)
  ok('canvas 被列入未翻译', unrecognized.length === 1 && unrecognized[0].includes('canvas'))
  const rewriting = (html) => html.replace('<html>', '<html data-x="1">')
  ok('改骨架本身 → outside 标记', translate(rewriting(PROBE)).outside === true)
  ok('正常新增 → outside 不置位', translate(weird(PROBE)).outside === false)
}

console.log('6) 多个元素按出现顺序翻译')
{
  const tap = (html) =>
    html.replace('<head>', '<head><style>.a{}</style>').replace('</body>', '<script src="/a.js"></script><script src="/b.js"></script></body>')
  const { rows } = translate(tap(PROBE))
  ok('共三行', rows.length === 3)
  ok('顺序：style → a.js → b.js', rows.map((r) => r.kind).join(',') === 'style,script-src,script-src')
  ok('a.js 在前', rows[1].src === '/a.js' && rows[2].src === '/b.js')
}

console.log('7) 桌面外壳判定')
{
  ok('无覆盖时按 argv 判定（当前进程不是桌面 Host）', isDesktopShell() === false)
  process.env.DSH_INDEX_TAP_BRIDGE = 'on'
  ok('强制 on 生效', isDesktopShell() === true)
  process.env.DSH_INDEX_TAP_BRIDGE = 'off'
  ok('强制 off 生效', isDesktopShell() === false)
  delete process.env.DSH_INDEX_TAP_BRIDGE
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exitCode = fail === 0 ? 0 : 1
