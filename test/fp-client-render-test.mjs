// dsh-system-fingerprint 客户端「渲染」回归测试。
//
// 背景：2026-10-17 的 bug——点击徽标触发强制探测时，组件把 `const { text, mono }`
// 重新赋值，渲染抛 `TypeError: Assignment to constant variable`；DSH 槽位框架的
// per-entry 错误边界会把这个条目「摘除」，于是整个徽标消失、F5 才回来。
// 旧的 fp-client-test.mjs 只测纯函数（buildPanelContent / badgeOf），测不到组件渲染本身，
// 所以这个文件补一层：用 jsdom + React 18 真正挂载组件、hover、点击。
//
// 依赖 jsdom + react 18；本仓库不带 node_modules，临时装一下即可：
//   npm i -D jsdom react react-dom
// 缺依赖时打印 SKIP 并以 0 退出。

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let req
try {
  const candidate = createRequire(import.meta.url)
  candidate('jsdom'); candidate('react'); candidate('react-dom/client')
  req = candidate
} catch { /* 依赖没装 */ }
if (req === undefined) {
  console.log('SKIP: 缺少 jsdom / react（npm i -D jsdom react react-dom 后再跑）')
  process.exit(0)
}

const { JSDOM } = req('jsdom')
const React = req('react')
const { createRoot } = req('react-dom/client')

const CHECKPOINT_STATE = {
  ok: true,
  value: {
    supported: true,
    provider: 'deepseek-official',
    requestedModel: 'deepseek-flash',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    modelSource: 'client',
    systemFingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
    fingerprintSource: 'probe',
    checkpoint: { name: 'flash 1017', plaintext: 'fp_dsv41f_1017_prod0820_fp8_kvcache_20260402_fp' },
    display: 'flash 1017',
    displayKind: 'checkpoint',
    probedAt: Date.now(),
    ageMs: 0,
    traceId: 'trace-fixture',
    stable: null,
    checks: 1,
    cached: false,
    stale: false,
    staleReason: null,
    endpoint: { host: 'api.deepseek.com', source: 'observed', sessionHeaderForwarded: true, conversationHost: 'api.deepseek.com' },
    confidence: 'high',
    confidenceNote: 'fixture',
    capture: { enabled: true, rawEnabled: true, total: 1, sessionTotal: 1, dir: 'storages/system-fingerprint/raw', last: null },
    note: 'fixture',
  },
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:6062/',
  pretendToBeVisual: true,
})
const { window } = dom
const expose = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch { /* ignore */ }
}
expose('window', window)
expose('document', window.document)
expose('navigator', window.navigator)
expose('HTMLElement', window.HTMLElement)
expose('MouseEvent', window.MouseEvent)
expose('FocusEvent', window.FocusEvent)
expose('getComputedStyle', window.getComputedStyle.bind(window))
expose('requestAnimationFrame', (fn) => setTimeout(fn, 16))
expose('cancelAnimationFrame', clearTimeout)

let factory
window.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f } }
vm.runInThisContext(readFileSync(CLIENT, 'utf8'), { filename: 'client.js' })
const requireShim = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return req('react/jsx-runtime')
  throw new Error(`unexpected require ${name}`)
}
const mod = factory(requireShim)

let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls += 1
  return { ok: true, json: async () => CHECKPOINT_STATE }
}

// 本轮渲染里被 React/槽位捕获的异常（React 会重新抛出未捕获的渲染错误，所以这里同时记 console.error）
const consoleErrors = []
const origError = console.error
console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); origError(...args) }

let Comp
const ctx = {
  effect: (fn) => { fn() },
  slots: { inject: (_name, fn) => fn(), register: (_spec, comp) => { Comp = comp } },
  locale: { register: () => {} },
}
mod.apply(ctx)
const t = (key) => (mod.__internals.dictionaries.zh[key] ?? key)
const useProjection = () => ({ lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } })

// 用一个小错误边界接住组件渲染错误：旧代码点击时会在这里被接住，测试报 FAIL 而不是整个进程崩掉。
let capturedRenderError = null
class CaptureBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError (error) { return { failed: true } }
  componentDidCatch (error) { capturedRenderError = error }
  render () { return this.state.failed ? null : this.props.children }
}

const root = createRoot(document.getElementById('root'))
root.render(React.createElement(CaptureBoundary, null, React.createElement(Comp, {
  sessionId: 'session-fixture',
  useProjection,
  t,
})))

const badge = () => document.querySelector('button')
const badgeText = () => badge()?.textContent ?? '(missing)'

await sleep(250)
check('挂载后显示检查点名', badgeText() === 'flash 1017', badgeText())

badge()?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
await sleep(80)
check('悬停打开悬浮卡片', document.querySelector('[role=tooltip]') !== null)

badge()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(120)
check('点击后进入「重新探测…」而不是崩溃', badgeText() === '重新探测…', badgeText())

await sleep(1100)
check('强制探测回来后恢复检查点名', badgeText() === 'flash 1017', badgeText())
check('点击确实触发了第二次请求', fetchCalls >= 2, `fetch=${fetchCalls}`)
check('没有渲染异常', capturedRenderError === null && consoleErrors.every((line) => !/constant variable|TypeError|slot entry crashed/u.test(line)),
  capturedRenderError !== null ? String(capturedRenderError) : consoleErrors.filter((line) => /constant variable|TypeError|slot entry crashed/u.test(line)).join(' | '))

console.error = origError
const failed = results.filter((row) => !row.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}: ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
