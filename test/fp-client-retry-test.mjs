#!/usr/bin/env node
/**
 * 回归：黄点什么时候出现、什么时候该自动复检（浏览器半边）。
 *
 * 这里钉住两个纯函数，因为它们决定用户看到的颜色与自动重取行为：
 *   * needsConfidenceRetry：可信度不是 high 的**探测结果**才复检；网关溯源/已拦截响应/错误不掺和。
 *   * badgeOf：只有「映射命中 + 非 A/B + high」才是绿点；其余一律警示色，告警再追加 ⚠。
 *
 * client.js 是 classic-script bundle（入口是 window.__ModuleLoader__.load），
 * 这里用假的 window + require 把它当模块加载，避免为两个纯函数拉 jsdom。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded.push(definition) } } }
await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)

const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }
const react = {
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
}
const definition = loaded[0]
assert.ok(definition && typeof definition.factory === 'function', 'client bundle 未注册')
const client = definition.factory((id) => {
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === 'react') return react
  throw new Error(`unexpected require: ${id}`)
})
const { badgeOf, needsConfidenceRetry } = client.__internals
assert.equal(typeof needsConfidenceRetry, 'function', 'needsConfidenceRetry 应导出给测试')
const t = (key) => `T:${key}`
const fingerprint = 'bc19ba97cbe016479903222bb1578db6'

const snapshot = (overrides = {}, alert = null) => ({
  kind: 'value',
  alert,
  value: {
    supported: true,
    provider: 'deepseek-official',
    requestedModel: 'deepseek-flash',
    model: 'deepseek-flash',
    systemFingerprint: fingerprint,
    fingerprintSource: 'probe',
    checkpoint: { name: 'flash 1027', plaintext: null },
    display: 'flash 1027',
    displayKind: 'checkpoint',
    abTest: false,
    fingerprintVariants: null,
    confidence: 'high',
    confidenceNote: '探测端点取自本会话真实请求的同源根',
    ...overrides,
  },
})

let failures = 0
function check (name, run) {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('needsConfidenceRetry：medium/low 探测结果要复检', () => {
  assert.equal(needsConfidenceRetry(snapshot({ confidence: 'medium' })), true)
  assert.equal(needsConfidenceRetry(snapshot({ confidence: 'low' })), true)
})
check('needsConfidenceRetry：high / 网关 / 已拦截响应 / 错误不复检', () => {
  assert.equal(needsConfidenceRetry(snapshot({ confidence: 'high' })), false)
  assert.equal(needsConfidenceRetry(snapshot({ supported: false, fingerprintSource: 'probe' })), false)
  assert.equal(needsConfidenceRetry(snapshot({ fingerprintSource: 'response', confidence: 'high' })), false)
  assert.equal(needsConfidenceRetry({ kind: 'error', error: { code: 'network' }, value: undefined }), false)
  assert.equal(needsConfidenceRetry({ kind: 'loading' }), false)
})
check('badgeOf：只有「命中 + 非 A/B + high」是绿点', () => {
  assert.equal(badgeOf(t, snapshot({ confidence: 'high' })).tone, 'known')
  assert.equal(badgeOf(t, snapshot({ confidence: 'medium' })).tone, 'unknown')
  assert.equal(badgeOf(t, snapshot({ confidence: 'low' })).tone, 'unknown')
})
check('badgeOf：映射未收录与 A/B 都算警示色', () => {
  const raw = badgeOf(t, snapshot({ displayKind: 'fingerprint', display: fingerprint, checkpoint: null, confidence: 'high' }))
  assert.equal(raw.tone, 'unknown')
  assert.equal(raw.mono, true, '未收录的 md5 应等宽显示')
  const ab = badgeOf(t, snapshot({ confidence: 'high', abTest: true, fingerprintVariants: [{ fingerprint: 'a', count: 2 }, { fingerprint: 'b', count: 1 }] }))
  assert.equal(ab.tone, 'unknown')
  assert.ok(ab.text.endsWith(' · A/B'), `A/B 文案应带标记，实际：${ab.text}`)
})
check('badgeOf：warn 告警追加 ⚠ 并转警示色', () => {
  const warned = badgeOf(t, snapshot({ confidence: 'high' }, { level: 'warn', signals: [] }))
  assert.equal(warned.tone, 'unknown')
  assert.ok(warned.text.endsWith(' ⚠'), `告警文案应带 ⚠，实际：${warned.text}`)
})
check('badgeOf：网关溯源不是指纹，走品牌色', () => {
  const gateway = badgeOf(t, {
    kind: 'value',
    alert: null,
    value: { supported: false, displayKind: 'gateway', display: 'manhattan-project', gateway: { endpointId: 'manhattan-project' } },
  })
  assert.equal(gateway.tone, 'gateway')
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
