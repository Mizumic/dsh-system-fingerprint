// dsh-system-fingerprint 宿主半边离线自测（v2：同源端点推导 + 可信度）。
// 不打印 API key；用 DSH_HOME 指向临时目录验证 raw/meta 落盘。
import { readFile, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = join(ROOT, '.test-home')
process.env.DSH_HOME = HOME
await rm(HOME, { recursive: true, force: true })

const mod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const I = mod._internals

let pass = 0
let fail = 0
function check (label, condition, extra = '') {
  if (condition) {
    pass += 1
    console.log(`PASS ${label}${extra ? ' :: ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${extra ? ' :: ' + extra : ''}`)
  }
}

// 1) 内置映射表
for (const row of I.DEFAULT_CHECKPOINTS) check(`md5(${row.name})`, I.md5Hex(row.plaintext) === row.fingerprint)

// 2) 配置归一化
const config = I.normalizeConfig({ checkpointTable: [{ name: 'only-plaintext', plaintext: 'abc' }] })
check('plaintext-only table derives md5', config.checkpoints[0].fingerprint === I.md5Hex('abc'))
const defaults = I.normalizeConfig(undefined)
check('default table size', defaults.checkpoints.length === 4)
check('default baseURL', defaults.openaiBaseURL === 'https://api.deepseek.com')
// 分发版隐私默认：拦截元数据开、原始字节落盘关（原始响应体可能含模型正文）。
check('capture default on', defaults.capture === true)
check('captureRaw default off (privacy)', defaults.captureRaw === false)
check('captureHeaders default on (redacted)', defaults.captureHeaders === true)
check('gateway header mapping default enabled', defaults.gatewayHeaders.enabled === true && defaults.gatewayHeaders.fields.length === 6)
check('gateway session header default', defaults.gatewaySessionHeader === 'x-opencode-session')
check('legacy captureRaw:true still wins', I.normalizeConfig({ captureRaw: true }).captureRaw === true)
check('capture:false is honored', I.normalizeConfig({ capture: false }).capture === false)
const customGateway = I.normalizeConfig({ gatewayHeaders: { endpointId: 'x-upstream-provider', rayId: false } })
check('custom gateway header mapping', customGateway.gatewayHeaders.fields.some((field) => field.key === 'endpointId' && field.header === 'x-upstream-provider') && !customGateway.gatewayHeaders.fields.some((field) => field.key === 'rayId'))
check('gatewayHeaders:false disables mapping', I.normalizeConfig({ gatewayHeaders: false }).gatewayHeaders.enabled === false)

// 3) 同源端点推导
const cases = [
  ['https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com'],
  ['https://api.deepseek.com/anthropic/messages', 'https://api.deepseek.com'],
  ['https://gw.example.com/ds/anthropic/v1/messages', 'https://gw.example.com/ds'],
  ['https://gw.example.com/v1/messages', 'https://gw.example.com'],
  ['https://gw.example.com/ds/v1/messages', 'https://gw.example.com/ds'],
  ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
  ['https://gw.example.com/v1/chat/completions', 'https://gw.example.com'],
  ['https://gw.example.com/ds/chat/completions', 'https://gw.example.com/ds'],
]
for (const [input, expected] of cases) {
  const got = I.deriveConversationBase(input)
  check(`derive ${input}`, got === expected, String(got))
}
check('probe paths (no /v1)', JSON.stringify(I.probePaths('https://api.deepseek.com')) === JSON.stringify(['/chat/completions', '/v1/chat/completions']))
check('probe paths (ends /v1)', JSON.stringify(I.probePaths('https://gw.example.com/v1')) === JSON.stringify(['/chat/completions']))

// 3b) 拦截范围：带 DSH 会话头的自定义网关 host 也必须拦截
const captureEnv = I.createEnv({ get: () => undefined }, { captureRaw: true })
const trustedGw = I.captureTargetOf(captureEnv, 'https://gw.example.com/ds/anthropic/v1/messages', {
  headers: { 'x-deepseek-harness-session-id': 'session-gw', 'x-deepseek-harness-user-id': 'u1' },
  body: JSON.stringify({ model: 'deepseek-flash' }),
})
check('capture custom gateway via harness header', trustedGw !== null && trustedGw.sessionId === 'session-gw', JSON.stringify(trustedGw))
check('capture custom gateway derives base', trustedGw && trustedGw.conversationBase === 'https://gw.example.com/ds', JSON.stringify(trustedGw && trustedGw.conversationBase))
const unrelated = I.captureTargetOf(captureEnv, 'https://other.example.com/v1/chat/completions', { headers: {}, body: '{}' })
check('capture ignores unrelated host', unrelated === null)
const official = I.captureTargetOf(captureEnv, 'https://api.deepseek.com/chat/completions', { headers: {}, body: JSON.stringify({ model: 'deepseek-flash' }) })
check('capture official host without headers', official !== null && official.kind === 'chat')
const probeMarked = I.captureTargetOf(captureEnv, 'https://gw.example.com/ds/chat/completions', {
  headers: { 'x-dsh-system-fingerprint-probe': '1', 'x-deepseek-harness-session-id': 'session-gw' },
  body: JSON.stringify({ model: 'deepseek-flash' }),
})
check('probe capture not attributed to session', probeMarked !== null && probeMarked.sessionId === null && probeMarked.probe === true && probeMarked.purpose === 'probe', JSON.stringify(probeMarked))

// 3c) 网关溯源头：默认映射 / 自定义映射 / 关闭
const gatewayDefaults = I.normalizeConfig(undefined)
const gwHeaders = new Headers({ 'x-opencode-endpoint-id': 'manhattan-project', 'x-opencode-log-id': 'L1' })
const gwDefault = I.extractGateway(gatewayDefaults, gwHeaders)
check('extract gateway default mapping', gwDefault !== null && gwDefault.endpointId === 'manhattan-project' && gwDefault.logId === 'L1')
check('extract gateway fields array', Array.isArray(gwDefault.fields) && gwDefault.fields[0].key === 'endpointId' && gwDefault.fields[0].header === 'x-opencode-endpoint-id')
const gwCustomConfig = I.normalizeConfig({ gatewayHeaders: { endpointId: 'x-upstream-provider' } })
const gwCustom = I.extractGateway(gwCustomConfig, new Headers({ 'x-upstream-provider': 'reflection-ai', 'x-opencode-endpoint-id': 'ignored' }))
check('extract gateway custom mapping', gwCustom !== null && gwCustom.endpointId === 'reflection-ai')
check('extract gateway disabled returns null', I.extractGateway(I.normalizeConfig({ gatewayHeaders: false }), gwHeaders) === null)

// 4) 原始文本提取
check('json fingerprint', I.extractFingerprint('{"system_fingerprint":"e72d3c7f663d3e1383b00b3884cb4501"}') === 'e72d3c7f663d3e1383b00b3884cb4501')
check('messages sse no fingerprint', I.extractFingerprint('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-flash"}}\n') === null)

// 5) 拦截落盘：带真实 requestUrl 的 chat 响应
const env = I.createEnv({ get: () => undefined }, { captureRaw: true })
const fakeBody = JSON.stringify({ model: 'deepseek-flash', system_fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' })
const fakeResponse = new Response(fakeBody, { status: 200, headers: { 'x-ds-trace-id': 'trace-123' } })
const meta = await I.captureResponse(env, fakeResponse, {
  kind: 'chat',
  path: '/chat/completions',
  requestUrl: 'https://api.deepseek.com/chat/completions',
  conversationBase: 'https://api.deepseek.com',
  sessionId: 'session-test-1',
  probe: false,
  requestModel: 'deepseek-flash',
  purpose: null,
})
check('capture requestUrl', meta.requestUrl === 'https://api.deepseek.com/chat/completions')
check('capture saved', meta.saved === true && meta.rawFile !== null)
const rawFiles = await readdir(join(HOME, 'storages/system-fingerprint/raw'))
check('raw file on disk', rawFiles.length === 1, rawFiles.join(','))
check('raw bytes pre-decode', (await readFile(join(HOME, 'storages/system-fingerprint/raw', rawFiles[0]), 'utf8')) === fakeBody)

// 5b) 存证元数据落盘（此时只有 env 一个实例在写 meta）
await new Promise((resolve) => setTimeout(resolve, 1800))
const persisted = JSON.parse(await readFile(join(HOME, 'storages/system-fingerprint/meta.json'), 'utf8'))
check('meta persisted entries', Array.isArray(persisted.entries) && persisted.entries.length === 1, String(persisted.entries.length))
check('meta persisted requestUrl', persisted.entries[0] && persisted.entries[0].requestUrl === 'https://api.deepseek.com/chat/completions')
check('meta persisted conversationBase', persisted.entries[0] && persisted.entries[0].conversationBase === 'https://api.deepseek.com')

// 6) 观察到的对话端点会进入「同层探测」候选
const conversationUrl = 'https://gw.example.com/ds/anthropic/v1/messages'
await I.captureResponse(env, new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-flash"}}\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }), {
  kind: 'messages',
  path: '/ds/anthropic/v1/messages',
  requestUrl: conversationUrl,
  conversationBase: 'https://gw.example.com/ds',
  sessionId: 'session-gw-1',
  harnessUserId: 'anon-user-1',
  requestModel: 'deepseek-flash',
  purpose: null,
})
const targetGw = { sessionId: 'session-gw-1', model: 'deepseek-flash', provider: 'deepseek-official' }
const candidates = I.probeEndpointCandidates(env, targetGw)
check('candidate[0] is observed', candidates[0].source === 'observed' && candidates[0].baseURL === 'https://gw.example.com/ds', JSON.stringify(candidates[0] && candidates[0].baseURL))
check('candidate[0] forwards session header', candidates[0].headers && candidates[0].headers['x-deepseek-harness-session-id'] === 'session-gw-1')
check('candidate[0] forwards user id', candidates[0].headers['x-deepseek-harness-user-id'] === 'anon-user-1')
check('candidate[1] is same-origin fallback', candidates[1].source === 'observed-origin' && candidates[1].baseURL === 'https://gw.example.com', JSON.stringify(candidates[1] && candidates[1].source))
check('candidate[2] is config fallback', candidates[2].source === 'config' && candidates[2].baseURL === 'https://api.deepseek.com')
check('observed-origin confidence medium', I.endpointConfidence(env, targetGw, { source: 'observed-origin', host: 'gw.example.com' }).confidence === 'medium')

// 7) 可信度分级
const high = I.endpointConfidence(env, targetGw, { source: 'observed', host: 'gw.example.com', sessionHeaderForwarded: true })
check('confidence high observed', high.confidence === 'high', high.confidenceNote)
const low = I.endpointConfidence(env, targetGw, { source: 'config', host: 'api.deepseek.com' })
check('confidence low fallback', low.confidence === 'low', low.confidenceNote)
const none = I.endpointConfidence(env, { sessionId: 'session-unknown', model: 'deepseek-flash', provider: 'deepseek-official' }, { source: 'config', host: 'api.deepseek.com' })
check('confidence low without observed', none.confidence === 'low', none.confidenceNote)

// 7b) 证据过滤：旧版带会话头的 chat 探针不能冒充「真实响应」；显式 probe:false 才认
{
  const baseEntry = {
    at: Date.now(),
    origin: 'session',
    purpose: null,
    sessionId: 'session-legacy',
    requestModel: 'deepseek-flash',
    responseModel: 'deepseek-flash',
    fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
    traceId: 'legacy-trace',
    rawFile: null,
    bytes: 0,
    truncated: false,
    saved: false,
  }
  const legacyEnv = I.createEnv({ get: () => undefined }, { captureRaw: true })
  legacyEnv.entries.push({ ...baseEntry, kind: 'chat' })
  check('legacy chat probe ignored as evidence', I.findRecordedFingerprint(legacyEnv, 'session-legacy', 'deepseek-flash') === null)

  const realChatEnv = I.createEnv({ get: () => undefined }, { captureRaw: true })
  realChatEnv.entries.push({ ...baseEntry, kind: 'chat', probe: false })
  check('explicit real chat accepted as evidence', I.findRecordedFingerprint(realChatEnv, 'session-legacy', 'deepseek-flash') !== null)

  const realMessagesEnv = I.createEnv({ get: () => undefined }, { captureRaw: true })
  realMessagesEnv.entries.push({ ...baseEntry, kind: 'messages' })
  check('messages response accepted as evidence', I.findRecordedFingerprint(realMessagesEnv, 'session-legacy', 'deepseek-flash') !== null)

  const probeEnv2 = I.createEnv({ get: () => undefined }, { captureRaw: true })
  probeEnv2.entries.push({ ...baseEntry, kind: 'messages', probe: true })
  check('probe-flagged entry never counts as evidence', I.findRecordedFingerprint(probeEnv2, 'session-legacy', 'deepseek-flash') === null)
}

// 8) 已拦截实际响应的状态：endpoint 来自真实请求，confidence high
const handled = await I.handleState(env, new Request('http://localhost/api/system-fingerprint/state?sessionId=session-test-1&provider=deepseek-official&model=deepseek-flash'))
check('state ok', handled.ok === true)
check('state source response', handled.value.fingerprintSource === 'response')
check('state display checkpoint', handled.value.display === 'flash 1017', String(handled.value.display))
check('state endpoint observed', handled.value.endpoint && handled.value.endpoint.host === 'api.deepseek.com' && handled.value.endpoint.source === 'observed', JSON.stringify(handled.value.endpoint))
check('state confidence high', handled.value.confidence === 'high')

// 9) 未收录指纹显示原始 md5
const env2 = I.createEnv({ get: () => undefined }, { captureRaw: true })
await I.captureResponse(env2, new Response(JSON.stringify({ model: 'unknown-model', system_fingerprint: '0123456789abcdef0123456789abcdef' }), { status: 200 }), {
  kind: 'chat',
  path: '/chat/completions',
  requestUrl: 'https://api.deepseek.com/chat/completions',
  conversationBase: 'https://api.deepseek.com',
  sessionId: 'session-test-2',
  probe: false,
  requestModel: 'unknown-model',
  purpose: null,
})
const handled2 = await I.handleState(env2, new Request('http://localhost/api/system-fingerprint/state?sessionId=session-test-2&provider=deepseek-official&model=unknown-model'))
check('state unmapped display raw md5', handled2.ok === true && handled2.value.display === '0123456789abcdef0123456789abcdef', JSON.stringify(handled2.value.display))

// 10) 非探测路由
const handled3 = await I.handleState(env2, new Request('http://localhost/api/system-fingerprint/state?provider=aliyun-bailian&model=glm-5.3'))
check('state unsupported provider', handled3.ok === true && handled3.value.supported === false, String(handled3.value.reason))

// 10b) 探针请求端到端：marker 头 → 拦截层归类为 probe（不污染真实对话证据）
{
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init && init.headers ? { ...init.headers } : {} })
    return new Response(JSON.stringify({ model: 'deepseek-flash', system_fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' }), {
      status: 200,
      headers: { 'x-ds-trace-id': 'fake-trace' },
    })
  }
  const fakeCtx = { get (name) { return name === 'credentials' ? { resolve: async () => ({ value: 'fake-key' }) } : undefined } }
  const probeEnv = I.createEnv(fakeCtx, { captureRaw: true })
  probeEnv.lastRequestBySession.set('session-probe-test', {
    at: Date.now(),
    requestUrl: 'https://gw.example.com/ds/anthropic/v1/messages',
    conversationBase: 'https://gw.example.com/ds',
    requestModel: 'deepseek-flash',
    harnessUserId: 'anon-user',
  })
  const uninstallProbeCapture = I.installFetchCapture(probeEnv)
  try {
    const target = { sessionId: 'session-probe-test', model: 'deepseek-flash', provider: 'deepseek-official' }
    const result = await I.probeCached(probeEnv, target, true)
    check('fake probe fingerprint', result.systemFingerprint === 'e72d3c7f663d3e1383b00b3884cb4501')
    check('fake probe goes to observed base', seen.length === 1 && seen[0].url === 'https://gw.example.com/ds/chat/completions', JSON.stringify(seen.map((item) => item.url)))
    check('fake probe sends marker header', seen[0].headers['x-dsh-system-fingerprint-probe'] === '1', JSON.stringify(seen[0].headers))
    check('fake probe forwards session header', seen[0].headers['x-deepseek-harness-session-id'] === 'session-probe-test')
    check('fake probe forwards user header', seen[0].headers['x-deepseek-harness-user-id'] === 'anon-user')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const probeEntry = probeEnv.entries.find((entry) => entry.kind === 'chat')
    check('probe capture classified as probe', probeEntry !== undefined && probeEntry.origin === 'probe' && probeEntry.sessionId === null && probeEntry.purpose === 'probe' && probeEntry.probe === true, JSON.stringify(probeEntry && { origin: probeEntry.origin, sessionId: probeEntry.sessionId, purpose: probeEntry.purpose, probe: probeEntry.probe }))
    check('probe capture did not overwrite observed endpoint', probeEnv.lastRequestBySession.get('session-probe-test').conversationBase === 'https://gw.example.com/ds')
    const probeState = await I.handleState(probeEnv, new Request('http://localhost/api/system-fingerprint/state?sessionId=session-probe-test&provider=deepseek-official&model=deepseek-flash'))
    check('probe state confidence high', probeState.ok === true && probeState.value.confidence === 'high', JSON.stringify(probeState.value && probeState.value.confidence))
    check('probe state capture not counted as session traffic', probeState.ok === true && probeState.value.capture.sessionTotal === 0, String(probeState.ok && probeState.value.capture.sessionTotal))
  } finally {
    uninstallProbeCapture()
    globalThis.fetch = originalFetch
  }
}

// 11) 真实探测 + 同源候选 + 拦截层捕获探针响应
let apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  try {
    const yaml = await readFile(join(ROOT, 'home/.credentials.yaml'), 'utf8')
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)/m.exec(yaml)
    if (match) apiKey = match[1]
  } catch {}
}
if (!apiKey) {
  console.log('SKIP live probe: no credential available in this shell')
} else {
  const ctx = {
    get (name) {
      if (name === 'credentials') return { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: apiKey } : undefined) }
      return undefined
    },
  }
  const liveEnv = I.createEnv(ctx, { captureRaw: true, cacheTtlMs: 5000, stabilityChecks: 2 })
  // 模拟「真实对话请求来自官方 Messages 端点」的观测
  liveEnv.lastRequestBySession.set('session-live-1', {
    at: Date.now(),
    requestUrl: 'https://api.deepseek.com/anthropic/v1/messages',
    conversationBase: 'https://api.deepseek.com',
    requestModel: 'deepseek-flash',
    harnessUserId: 'anon-user',
  })
  const uninstall = I.installFetchCapture(liveEnv)
  try {
    const liveTarget = { sessionId: 'session-live-1', model: 'deepseek-flash', provider: 'deepseek-official' }
    const liveCandidates = I.probeEndpointCandidates(liveEnv, liveTarget)
    check('live candidate observed first', liveCandidates[0].source === 'observed' && liveCandidates[0].baseURL === 'https://api.deepseek.com')
    const probe = await I.probeCached(liveEnv, liveTarget, true)
    check('live probe fingerprint', /^[0-9a-f]{32}$/.test(probe.systemFingerprint), probe.systemFingerprint)
    check('live probe endpoint observed', probe.endpoint && probe.endpoint.source === 'observed', JSON.stringify(probe.endpoint && probe.endpoint.source))
    check('live probe confidence high', probe.confidence === 'high', String(probe.confidence))
    check('live probe stable', probe.stable === true, String(probe.stable))
    await new Promise((resolve) => setTimeout(resolve, 3000))
    check('interception captured probe', liveEnv.entries.some((entry) => entry.kind === 'chat' && entry.fingerprint === probe.systemFingerprint), String(liveEnv.entries.length))
    const liveHandled = await I.handleState(liveEnv, new Request('http://localhost/api/system-fingerprint/state?sessionId=session-live-1&provider=deepseek-official&model=deepseek-flash&refresh=1'))
    check('live state display', liveHandled.ok === true && liveHandled.value.display === 'flash 1017', JSON.stringify(liveHandled.value && liveHandled.value.display))
    check('live state endpoint field', liveHandled.ok === true && liveHandled.value.endpoint && liveHandled.value.endpoint.source === 'observed')
    check('live entries carry conversationBase', liveEnv.entries.every((entry) => typeof entry.conversationBase === 'string' && entry.conversationBase.length > 0), JSON.stringify(liveEnv.entries.map((entry) => entry.conversationBase)))
  } finally {
    uninstall()
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
