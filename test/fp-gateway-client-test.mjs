// dsh-system-fingerprint 客户端渲染离线验收（网关溯源 / 不适用 / 检查点三分支，不起浏览器）。
//
// client.js 是 classic-script bundle（走 window.__ModuleLoader__），这里用桩 require 加载工厂，
// 直接调 __internals.buildPanelContent / badgeOf。渲染真实组件的行为在 fp-client-render-test.mjs。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let definition
const stubRequire = (id) => {
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
  if (id === 'react') return { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [null, () => {}] }
  throw new Error(`未预期的 require: ${id}`)
}
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { definition = def } } },
  console,
  URL,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
assert.equal(definition.id, 'dsh-system-fingerprint', '未拿到插件定义')

const client = definition.factory(stubRequire)
const { buildPanelContent, badgeOf, dictionaries } = client.__internals
const t = (key) => dictionaries.zh[key] ?? key
const texts = (content) => [
  ...content.rows.map((row) => `${row.label}=${row.value}`),
  ...content.notes,
]

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}
const both = (content) => [...content.rows.map((row) => `${row.label}=${row.value}`), ...content.notes].join('\n')

// ── 网关溯源分支 ─────────────────────────────────────────────────────────────
const baseGateway = {
  supported: false,
  reason: 'gateway-provenance',
  displayKind: 'gateway',
  display: 'orcarouter-dsv4.1flash',
  provider: 'opencode-go',
  requestedModel: 'deepseek-v4.1-flash',
  model: 'deepseek-v4.1-flash',
  fingerprint: { available: false, systemFingerprint: null, checkpoint: null, reason: 'upstream-no-system-fingerprint' },
  gateway: {
    fields: [
      { key: 'endpointId', value: 'orcarouter-dsv4.1flash' },
      { key: 'upstreamModelId', value: 'deepseek/deepseek-v4.1-flash' },
      { key: 'logId', value: '14cc85cb-fb78-430c-9f5a-81392048530a' },
      { key: 'zenModel', value: 'deepseek-v4.1-flash' },
    ],
    endpointId: 'orcarouter-dsv4.1flash',
    upstreamModelId: 'deepseek/deepseek-v4.1-flash',
    logId: '14cc85cb-fb78-430c-9f5a-81392048530a',
    zenModel: 'deepseek-v4.1-flash',
    placement: 'remote-ORD',
    rayId: 'a4bd9df1dfe196ba-PDX',
    at: Date.now() - 4200,
    ageMs: 4200,
    sessionId: 'session-edf9c7ee-6604-4f35-b013-cc8a3f5d8559',
    sessionIdSource: 'gateway',
    matchedBy: 'session',
    requestPath: '/zen/go/v1/chat/completions',
    endpointHost: 'opencode.ai',
  },
  probedAt: Date.now() - 4200,
  ageMs: 4200,
  traceId: '14cc85cb-fb78-430c-9f5a-81392048530a',
  endpoint: { host: 'opencode.ai', source: 'observed', apiPath: '/zen/go/v1/chat/completions', conversationHost: 'opencode.ai', sessionHeaderForwarded: true },
  confidence: 'high',
  confidenceNote: '来自本会话真实响应头（解码前拦截）',
  capture: { enabled: true, rawEnabled: true, total: 3, sessionTotal: 1, last: { at: Date.now(), kind: 'chat', truncated: false, saved: true } },
  note: '该上游不返回 system_fingerprint；以下是请求级网关溯源，标识请求落到哪个后端池',
}
const gatewayContent = buildPanelContent(t, { kind: 'value', value: baseGateway })
check('C1 网关模式列出后端池/上游路由/请求 ID', () => {
  const all = both(gatewayContent)
  assert.match(all, /后端池=orcarouter-dsv4\.1flash/)
  assert.match(all, /上游路由=deepseek\/deepseek-v4\.1-flash/)
  assert.match(all, /请求日志 id=14cc85cb/)
  assert.match(all, /opencode\.ai/)
})
check('C2 网关模式显式声明「这不是模型指纹」', () => {
  const notes = gatewayContent.notes.join('\n')
  assert.match(notes, /这不是模型指纹/)
  assert.match(notes, /按会话绑定/)
})
check('C3 网关模式不出现检查点/指纹行', () => {
  const all = both(gatewayContent)
  assert.ok(!all.includes('检查点='), '不应出现检查点行')
  assert.ok(!all.includes('system_fingerprint='), '不应出现指纹行')
})
check('C4 徽标直接显示后端池名字（不回退到通用标签）', () => {
  const badge = badgeOf(t, { kind: 'value', value: baseGateway })
  assert.equal(badge.text, 'orcarouter-dsv4.1flash')
  assert.equal(badge.tone, 'gateway')
  assert.equal(badge.mono, true)
})
check('C7 池名缺失时才回退到「网关溯源」', () => {
  const noName = { ...baseGateway, display: '', gateway: { ...baseGateway.gateway, endpointId: null, zenModel: null, fields: [] } }
  const badge = badgeOf(t, { kind: 'value', value: noName })
  assert.equal(badge.text, dictionaries.zh['badge.gateway'])
  assert.equal(badge.tone, 'gateway')
})
check('C8 检查点分支的徽标文案未被改坏', () => {
  const badge = badgeOf(t, {
    kind: 'value',
    value: {
      supported: true, displayKind: 'checkpoint', display: 'flash 1017（新）',
      systemFingerprint: 'e72d3c7f663d3e1383b00b3884cb4501', confidence: 'high',
    },
  })
  assert.equal(badge.text, 'flash 1017（新）')
  assert.equal(badge.tone, 'known')
})
check('C9 老存证没有 gateway.fields 时按已知角色回退渲染（升级兼容）', () => {
  const legacy = {
    ...baseGateway,
    gateway: { ...baseGateway.gateway, fields: undefined },
  }
  const legacyContent = buildPanelContent(t, { kind: 'value', value: legacy })
  const all = both(legacyContent)
  assert.match(all, /后端池=orcarouter-dsv4\.1flash/)
  assert.match(all, /请求日志 id=14cc85cb/)
  // placement / rayId 在旧存证里也会被回退渲染（有值就展示）
  assert.match(all, /边缘落点=remote-ORD/)
  assert.match(all, /ray id=a4bd9df1dfe196ba-PDX/)
})
check('C10 自定义网关字段（键名不是已知角色）照实展示，标签用键名', () => {
  const custom = {
    ...baseGateway,
    display: 'reflection-ai',
    gateway: {
      ...baseGateway.gateway,
      fields: [
        { key: 'endpointId', value: 'reflection-ai' },
        { key: 'cache', value: 'MISS' },
      ],
      endpointId: 'reflection-ai',
    },
  }
  const customContent = buildPanelContent(t, { kind: 'value', value: custom })
  const all = both(customContent)
  assert.match(all, /后端池=reflection-ai/)
  assert.match(all, /cache=MISS/)
})
check('C11 网关模式下 capture.rawEnabled:false 时说明「元数据已拦截、原始字节不落盘」', () => {
  const privacy = {
    ...baseGateway,
    capture: { enabled: true, rawEnabled: false, total: 5, sessionTotal: 2, last: null },
  }
  const privacyContent = buildPanelContent(t, { kind: 'value', value: privacy })
  const all = both(privacyContent)
  assert.match(all, /响应存证=/)
  assert.match(all, /元数据/)
  assert.match(all, /不落盘/)
})

// ── 回归：不适用 / 检查点 ───────────────────────────────────────────────────
const unsupported = buildPanelContent(t, {
  kind: 'value',
  value: { supported: false, reason: 'provider-not-probeable', provider: 'opencode-go', requestedModel: 'x' },
})
check('C5 无存证时仍走「不适用」说明', () => {
  assert.match(unsupported.notes.join('\n'), /不在探测范围内/)
})

const checkpoint = buildPanelContent(t, {
  kind: 'value',
  value: {
    supported: true,
    provider: 'deepseek-official',
    requestedModel: 'deepseek-flash',
    model: 'deepseek-flash',
    systemFingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
    fingerprintSource: 'response',
    checkpoint: { name: 'flash 1017（新）', plaintext: 'fp_dsv41f_1017_prod0820_fp8_kvcache_20260402_fp' },
    display: 'flash 1017（新）',
    displayKind: 'checkpoint',
    probedAt: Date.now(),
    ageMs: 0,
    confidence: 'high',
    stable: null,
    capture: { enabled: true, rawEnabled: true, total: 1, last: { at: Date.now(), kind: 'messages', truncated: false, saved: true } },
  },
})
check('C6 检查点分支没有被改坏', () => {
  const all = both(checkpoint)
  assert.match(all, /检查点=flash 1017/)
  assert.match(all, /system_fingerprint=e72d3c7f663d3e1383b00b3884cb4501/)
})

// ── 测试词表完整性（中英双语都要有新增的键） ───────────────────────────────
check('C12 新增词典键中英双语齐全', () => {
  for (const key of ['note.captureRawOff', 'note.captureEvidenceOnly', 'note.captureDisabled',
    'label.gatewayPlacement', 'label.gatewayRay']) {
    assert.equal(typeof dictionaries.zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof dictionaries.en[key], 'string', `en 缺 ${key}`)
  }
})

for (const [status, name, message] of results) {
  console.log(`${status === 'PASS' ? '  ✓' : '  ✗'} ${name}${message ? ` — ${message}` : ''}`)
}
const failed = results.filter((row) => row[0] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
