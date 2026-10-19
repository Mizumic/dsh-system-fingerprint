// dsh-system-fingerprint 网关溯源模式离线验收（不起 dsh 进程）。
//
// 覆盖：
//   A. 配置：默认放行 opencode.ai / capture 默认开、captureRaw 默认关 / 网关头映射可覆盖
//   B. extractGateway：默认映射、自定义映射、关闭、空返回
//   C. 会话关联：网关会话头 / harness 头优先 / 自定义会话头 / 关闭
//   D. 拦截存证：网关证据 + 无指纹 + 原始字节落盘（显式 captureRaw:true）
//   E. state 路由：displayKind=gateway、指纹维度标不可用、可信度与主显示
//   F. 回归：官方 DeepSeek 路由的指纹路径没被改坏
//   G/H. 重新启用 bundle 配置立即生效；跨版本热升级不叠层、不静默失效
//   I. 路由端点登记表（持续累积 + 落盘读回）
//   J. 请求头/响应头捕获的脱敏与限长
//   K. 隐私默认：captureRaw 不落原始字节，但元数据/证据照常（可分发型的关键默认）
//   L. 供应商无关：自定义网关映射 / 自定义会话头 / 无 endpointId 角色的兜底 / 旧存证兼容
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = mkdtempSync(join(tmpdir(), 'fp-gw-'))
process.env.DSH_HOME = HOME
delete process.env.DEEPSEEK_BASE_URL

const { _internals } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const {
  DEFAULT_GATEWAY_HEADERS,
  DEFAULT_GATEWAY_SESSION_HEADER,
  accumulateEndpoint,
  captureResponse,
  captureSummaryOf,
  captureTargetOf,
  createEnv,
  emptyEndpointRegistry,
  extractGateway,
  extractRequestHeaders,
  extractResponseId,
  findRecordedGateway,
  handleState,
  headersToObject,
  hydrateEndpoints,
  installFetchCapture,
  normalizeConfig,
  normalizeGatewayHeaders,
  normalizeGatewayHosts,
  normalizeGatewaySessionHeader,
  persistEndpoints,
  responseIdFamily,
} = _internals

const stubCtx = () => ({ get: () => undefined })
const SESSION = 'session-edf9c7ee-6604-4f35-b013-cc8a3f5d8559'
const GW_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const DS_URL = 'https://api.deepseek.com/anthropic/v1/messages'

const results = []
const run = async (name, fn) => {
  try {
    await fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}
const checks = (name, fn) => run(name, fn)
const waitFor = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const stateReq = (query) => new Request(`http://localhost/api/system-fingerprint/state?${query}`)

// ── A. 配置 ──────────────────────────────────────────────────────────────────
await checks('A1 默认放行 opencode.ai / api.deepseek.com，capture 开、captureRaw 关', () => {
  const config = normalizeConfig({})
  assert.ok(config.captureHosts.has('opencode.ai'), '缺少 opencode.ai')
  assert.ok(config.captureHosts.has('api.deepseek.com'), '缺少 api.deepseek.com')
  assert.ok(config.gatewayHosts.has('opencode.ai'))
  assert.equal(config.capture, true, '响应拦截默认应当开启（只留元数据）')
  assert.equal(config.captureRaw, false, '原始字节落盘默认必须关（隐私）')
})
await checks('A2 显式 captureHosts 也不会把网关 host 挤掉', () => {
  const config = normalizeConfig({ captureHosts: ['example.com'] })
  assert.ok(config.captureHosts.has('example.com'))
  assert.ok(config.captureHosts.has('opencode.ai'), 'gatewayHosts 应无条件并入')
})
await checks('A3 gatewayHosts 可追加（URL 形式也认）', () => {
  const hosts = normalizeGatewayHosts(['https://gw.example.com/base'])
  assert.ok(hosts.has('gw.example.com'))
  assert.ok(hosts.has('opencode.ai'))
})
await checks('A4 默认网关头映射覆盖六个语义角色', () => {
  const mapping = normalizeGatewayHeaders(undefined)
  assert.equal(mapping.enabled, true)
  assert.deepEqual(mapping.fields.map((field) => field.key), Object.keys(DEFAULT_GATEWAY_HEADERS))
  assert.equal(mapping.fields[0].header, 'x-opencode-endpoint-id')
})
await checks('A5 网关头映射按角色部分覆盖，未写的角色保持默认', () => {
  const mapping = normalizeGatewayHeaders({ endpointId: 'x-upstream-provider', logId: 'x-request-id' })
  const byKey = Object.fromEntries(mapping.fields.map((field) => [field.key, field.header]))
  assert.equal(byKey.endpointId, 'x-upstream-provider')
  assert.equal(byKey.logId, 'x-request-id')
  assert.equal(byKey.upstreamModelId, 'x-opencode-upstream-model-id')
})
await checks('A6 角色写 false / null 表示去掉该角色', () => {
  const mapping = normalizeGatewayHeaders({ rayId: false, placement: null, zenModel: '' })
  const keys = mapping.fields.map((field) => field.key)
  assert.ok(!keys.includes('rayId'))
  assert.ok(!keys.includes('placement'))
  assert.ok(!keys.includes('zenModel'))
})
await checks('A7 角色之外的自定义键名会作为附加字段保留', () => {
  const mapping = normalizeGatewayHeaders({ cache: 'x-cache-status' })
  const extra = mapping.fields.find((field) => field.key === 'cache')
  assert.equal(extra.header, 'x-cache-status')
})
await checks('A8 gatewayHeaders: false 整体关闭网关溯源', () => {
  const mapping = normalizeGatewayHeaders(false)
  assert.equal(mapping.enabled, false)
  assert.deepEqual(mapping.fields, [])
})
await checks('A9 网关会话头：默认 / 自定义 / 关闭', () => {
  assert.equal(normalizeGatewaySessionHeader(undefined), DEFAULT_GATEWAY_SESSION_HEADER)
  assert.equal(normalizeGatewaySessionHeader('X-My-Session'), 'x-my-session')
  assert.equal(normalizeGatewaySessionHeader(false), null)
  assert.equal(normalizeGatewaySessionHeader(''), DEFAULT_GATEWAY_SESSION_HEADER)
})

// ── B. 溯源头提取 ────────────────────────────────────────────────────────────
const gwHeaders = new Headers({
  'x-opencode-endpoint-id': 'manhattan-project',
  'x-opencode-upstream-model-id': 'deepseek/deepseek-v4.1-flash',
  'x-opencode-log-id': '14cc85cb-fb78-430c-9f5a-81392048530a',
  'x-zen-model': 'deepseek-v4.1-flash',
  'cf-placement': 'remote-ORD',
  'cf-ray': 'a4bd9df1dfe196ba-PDX',
})
await checks('B1 默认映射取到全部溯源头（含 fields 顺序）', () => {
  const gateway = extractGateway(normalizeConfig({}), gwHeaders)
  assert.equal(gateway.endpointId, 'manhattan-project')
  assert.equal(gateway.upstreamModelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(gateway.logId, '14cc85cb-fb78-430c-9f5a-81392048530a')
  assert.equal(gateway.zenModel, 'deepseek-v4.1-flash')
  assert.equal(gateway.source, 'headers')
  assert.deepEqual(gateway.fields.map((field) => field.key), [
    'endpointId', 'upstreamModelId', 'logId', 'zenModel', 'placement', 'rayId',
  ])
})
await checks('B2 无相关头 / 关闭映射时返回 null', () => {
  assert.equal(extractGateway(normalizeConfig({}), new Headers({ 'content-type': 'application/json' })), null)
  assert.equal(extractGateway(normalizeConfig({}), undefined), null)
  assert.equal(extractGateway(normalizeConfig({ gatewayHeaders: false }), gwHeaders), null)
})
await checks('B3 自定义映射只读配置的头，未配置的默认头不再读取', () => {
  const config = normalizeConfig({
    gatewayHeaders: { endpointId: 'x-upstream-provider', logId: 'x-request-id' },
  })
  const gateway = extractGateway(config, new Headers({
    'x-opencode-endpoint-id': 'should-not-be-read',
    'x-upstream-provider': 'reflection-ai',
    'x-request-id': 'req-1',
    'x-opencode-log-id': 'ignored-too',
  }))
  assert.equal(gateway.endpointId, 'reflection-ai')
  assert.equal(gateway.logId, 'req-1')
  assert.equal(gateway.upstreamModelId, undefined)
  assert.deepEqual(gateway.fields.map((field) => field.key), ['endpointId', 'logId'])
})

// ── C. 会话关联 ──────────────────────────────────────────────────────────────
const env = createEnv(stubCtx(), { captureRaw: true })
let gwTarget
await checks('C1 网关请求经 x-opencode-session 关联到会话', () => {
  gwTarget = captureTargetOf(env, GW_URL, {
    method: 'POST',
    headers: { 'x-opencode-session': SESSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  })
  assert.ok(gwTarget, '应当拦截')
  assert.equal(gwTarget.sessionId, SESSION)
  assert.equal(gwTarget.sessionIdSource, 'gateway')
  assert.equal(gwTarget.kind, 'chat')
  assert.equal(gwTarget.requestModel, 'deepseek-v4.1-flash')
  assert.equal(gwTarget.conversationBase, 'https://opencode.ai/zen/go')
})
await checks('C2 harness 会话头优先于网关会话头', () => {
  const target = captureTargetOf(env, DS_URL, {
    headers: { 'x-deepseek-harness-session-id': SESSION, 'x-opencode-session': 'other' },
    body: JSON.stringify({ model: 'deepseek-flash' }),
  })
  assert.equal(target.sessionId, SESSION)
  assert.equal(target.sessionIdSource, 'harness')
})
await checks('C3 自定义网关会话头同样能把响应关联回会话', () => {
  const customEnv = createEnv(stubCtx(), { gatewaySessionHeader: 'x-my-session' })
  const target = captureTargetOf(customEnv, 'https://opencode.ai/zen/go/v1/chat/completions', {
    headers: { 'x-my-session': SESSION },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  })
  assert.equal(target.sessionId, SESSION)
  assert.equal(target.sessionIdSource, 'gateway')
})
await checks('C4 关掉网关会话头后不强行关联（不再读默认头）', () => {
  const customEnv = createEnv(stubCtx(), { gatewaySessionHeader: false })
  const target = captureTargetOf(customEnv, 'https://opencode.ai/zen/go/v1/chat/completions', {
    headers: { 'x-opencode-session': SESSION },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  })
  assert.ok(target, '显式 gatewayHosts 的 host 仍应拦截（供模型兜底）')
  assert.equal(target.sessionId, null)
  assert.equal(target.sessionIdSource, null)
})

// ── D. 拦截落盘（显式开启 captureRaw 的部署） ───────────────────────────────
const gwBody = JSON.stringify({
  id: 'gw-275c2fc21cdf-c79ec',
  object: 'chat.completion',
  model: 'deepseek-v4.1-flash',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 31, completion_tokens: 1, total_tokens: 32 },
})
await captureResponse(env, new Response(gwBody, {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-opencode-endpoint-id': 'orcarouter-dsv4.1flash',
    'x-opencode-upstream-model-id': 'deepseek/deepseek-v4.1-flash',
    'x-opencode-log-id': 'a4bd9df1-0000-0000-0000-000000000001',
  },
}), gwTarget)

await checks('D1 存证里有 gateway 且无 fingerprint，原始字节落盘', () => {
  const entry = env.entries[0]
  assert.equal(entry.fingerprint, null, '网关路由不该有指纹')
  assert.equal(entry.gateway.endpointId, 'orcarouter-dsv4.1flash')
  assert.equal(entry.sessionId, SESSION)
  assert.equal(entry.sessionIdSource, 'gateway')
  assert.equal(entry.responseModel, 'deepseek-v4.1-flash')
  assert.equal(entry.saved, true, '原始字节应落盘')
})
await checks('D2 findRecordedGateway 按会话命中', () => {
  const hit = findRecordedGateway(env, SESSION, 'deepseek-v4.1-flash')
  assert.ok(hit, '应命中')
  assert.equal(hit.matchedBy, 'session')
})
await checks('D3 其它会话按 model + 时间窗兜底；对不上的 model 不误命中', () => {
  assert.equal(findRecordedGateway(env, 'session-other', 'deepseek-v4.1-flash').matchedBy, 'model')
  assert.equal(findRecordedGateway(env, 'session-other', 'deepseek-flash'), null)
})

// ── E. state 路由 ────────────────────────────────────────────────────────────
const gwState = await handleState(env, stateReq(
  `sessionId=${SESSION}&provider=opencode-go&model=${encodeURIComponent('deepseek-v4.1-flash')}`,
))
await checks('E1 网关路由返回 displayKind=gateway，主显示取第一个溯源字段', () => {
  assert.equal(gwState.ok, true)
  assert.equal(gwState.value.displayKind, 'gateway')
  assert.equal(gwState.value.reason, 'gateway-provenance')
  assert.equal(gwState.value.display, 'orcarouter-dsv4.1flash')
})
await checks('E2 指纹维度明确标成不可用，不冒充检查点', () => {
  assert.equal(gwState.value.supported, false)
  assert.equal(gwState.value.systemFingerprint, undefined)
  assert.equal(gwState.value.fingerprint.available, false)
  assert.equal(gwState.value.fingerprint.systemFingerprint, null)
  assert.equal(gwState.value.fingerprint.reason, 'upstream-no-system-fingerprint')
  assert.equal(gwState.value.checkpoint, undefined)
})
await checks('E3 溯源字段 + 可信度 + 来源说明齐全', () => {
  const gateway = gwState.value.gateway
  assert.equal(gateway.upstreamModelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(gateway.logId, 'a4bd9df1-0000-0000-0000-000000000001')
  assert.equal(gateway.matchedBy, 'session')
  assert.equal(gateway.endpointHost, 'opencode.ai')
  assert.ok(Array.isArray(gateway.fields) && gateway.fields.length >= 3, 'fields 应当给 UI 用')
  assert.equal(gwState.value.confidence, 'high')
  assert.match(gwState.value.note, /不是模型指纹|网关溯源/)
})
await checks('E4 无任何存证的网关会话仍是「不适用」', async () => {
  const other = await handleState(env, stateReq('sessionId=session-unknown&provider=opencode-go&model=nope-1'))
  assert.equal(other.value.supported, false)
  assert.equal(other.value.reason, 'provider-not-probeable')
  assert.equal(other.value.displayKind, undefined)
})

// ── D4/D5. 存证扩展名按实际形态（放在 E 之后，避免污染「最新一条」证据） ──────
await captureResponse(env, new Response(
  'data: {"id":"gw-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream', 'x-opencode-endpoint-id': 'manhattan-project' } },
), captureTargetOf(env, GW_URL, {
  method: 'POST',
  headers: { 'x-opencode-session': SESSION },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
}))
await checks('D4 流式 chat 存证存成 .sse（网关路由永远流式）', () => {
  const entry = env.entries[0]
  assert.equal(entry.streamed, true)
  assert.match(entry.rawFile, /-chat-.*\.sse$/u, `实际 ${entry.rawFile}`)
})
await checks('D5 非流式 chat 存证仍是 .json', () => {
  const entry = env.entries.find((item) => item.rawFile && item.rawFile.endsWith('.json'))
  assert.ok(entry, '应有一条 .json 存证')
  assert.equal(entry.streamed, false)
})

// ── F. 回归：官方路由指纹路径 ────────────────────────────────────────────────
const dsTarget = captureTargetOf(env, DS_URL, {
  method: 'POST',
  headers: { 'x-deepseek-harness-session-id': SESSION },
  body: JSON.stringify({ model: 'deepseek-flash' }),
})
await captureResponse(env, new Response(
  'event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-flash"}}\n\n' +
  'data: {"type":"message_delta","system_fingerprint":"e72d3c7f663d3e1383b00b3884cb4501"}\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream', 'x-ds-trace-id': 'trace-abc' } },
), dsTarget)
await checks('F1 messages 响应里的指纹仍被解析', () => {
  const entry = env.entries.find((item) => item.kind === 'messages')
  assert.equal(entry.fingerprint, 'e72d3c7f663d3e1383b00b3884cb4501')
  assert.equal(entry.gateway, null, '官方路由没有网关溯源头')
})
const dsState = await handleState(env, stateReq(`sessionId=${SESSION}&provider=deepseek-official&model=deepseek-flash`))
await checks('F2 官方路由仍走检查点模式（优先真实响应）', () => {
  const expected = normalizeConfig({}).tableByFingerprint.get('e72d3c7f663d3e1383b00b3884cb4501')
  assert.ok(expected, '内置表里应当有 e72d3c7f… 这一行')
  assert.equal(dsState.value.supported, true)
  assert.equal(dsState.value.displayKind, 'checkpoint')
  assert.equal(dsState.value.display, expected.name)
  assert.equal(dsState.value.fingerprintSource, 'response')
})

// ── G. 重新启用 bundle：配置立即生效 ─────────────────────────────────────────
const originalFetch = globalThis.fetch
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
const envA = createEnv(stubCtx(), { captureRaw: true })
const envB = createEnv(stubCtx(), { capture: false })
installFetchCapture(envA)
installFetchCapture(envB) // 第二个实例：只换 env 槽位
const callGateway = () => globalThis.fetch(GW_URL, {
  method: 'POST',
  headers: { 'x-opencode-session': SESSION },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
})
await callGateway()
await new Promise((resolve) => setTimeout(resolve, 150))
await checks('G1 重新启用后新配置生效（capture:false 不拦截）', () => {
  assert.equal(envA.captureCount, 0)
  assert.equal(envB.captureCount, 0)
})
installFetchCapture(envA) // 换回开启拦截的实例
await callGateway()
await checks('G2 换回后立刻恢复抓取，不必重启进程', async () => {
  assert.ok(await waitFor(() => envA.captureCount === 1), '未抓到')
})
globalThis.fetch = originalFetch

// ── H. 跨版本热升级：旧版补丁在位时不能挡住新实现 ───────────────────────────
const MARK = Symbol.for('dsh.system-fingerprint.fetch-patched')
const PATCH_ORIGINAL = Symbol.for('dsh.system-fingerprint.fetch-original')
const envC = createEnv(stubCtx(), {})
const legacyV1 = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
legacyV1[MARK] = 1 // 旧版本号（并且它自身上记录了原始 fetch）
legacyV1[PATCH_ORIGINAL] = originalFetch
globalThis.fetch = legacyV1
installFetchCapture(envC)
await checks('H1 旧版本补丁被摘掉，新实现直接包住原始 fetch（不叠层）', () => {
  assert.equal(globalThis.fetch[MARK], true, '应当是本插件的补丁')
  assert.equal(globalThis.fetch[PATCH_ORIGINAL], originalFetch, '应当直接包住原始 fetch，而不是旧补丁')
})
await globalThis.fetch(GW_URL, {
  method: 'POST',
  headers: { 'x-opencode-session': SESSION },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
})
const h2ok = await waitFor(() => envC.captureCount >= 1)
await checks('H2 升级后新代码立即生效（网关响应头被记录）', () => {
  assert.ok(h2ok, '未抓到')
  const entry = envC.entries[0]
  assert.equal(entry.sessionIdSource, 'gateway')
  assert.equal(entry.fingerprint, null)
})

// v1 时代补丁没有 original 记录：只能叠一层，但同样必须能抓（不能静默失效）
const envD = createEnv(stubCtx(), {})
const legacyTrue = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
legacyTrue[MARK] = true
globalThis.fetch = legacyTrue
installFetchCapture(envD)
await globalThis.fetch(GW_URL, {
  method: 'POST',
  headers: { 'x-opencode-session': SESSION },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
})
const h3ok = await waitFor(() => envD.captureCount >= 1)
await checks('H3 老式布尔标记的补丁也不会让新实现静默失效', () => {
  assert.equal(globalThis.fetch[MARK], true)
  assert.ok(h3ok, '未抓到')
})
const envE = createEnv(stubCtx(), {})
installFetchCapture(envE)
await checks('H4 重复 apply 不套娃：链上仍只有一个本插件补丁', () => {
  assert.equal(globalThis.fetch[MARK], true)
  assert.equal(globalThis.fetch[PATCH_ORIGINAL], legacyTrue, '不该包住自己上一个补丁')
})
globalThis.fetch = originalFetch

// ── I. 路由端点登记表（持续累积 + 可扩展） ───────────────────────────────────
const envReg = createEnv(stubCtx(), {})
const now = Date.now()
accumulateEndpoint(envReg, {
  at: now, status: 200, gateway: { endpointId: 'manhattan-project', upstreamModelId: 'deepseek-v4.1-flash', logId: 'L1', rayId: 'R1', placement: 'remote-ORD', zenModel: 'deepseek-v4.1-flash' },
  responseModel: 'deepseek-v4.1-flash', responseId: 'gw-275c2fc21cdf-c79ec', sessionId: SESSION, sessionIdSource: 'gateway',
  conversationBase: 'https://opencode.ai/zen/go',
})
accumulateEndpoint(envReg, {
  at: now + 1000, status: 200, probe: true, purpose: 'probe',
  gateway: { endpointId: 'manhattan-project', upstreamModelId: 'deepseek-v4.1-flash' },
  responseModel: 'deepseek-v4.1-flash', responseId: '021792223753404c323afa74840446e61be924aaf3459ee36dfc9',
})
accumulateEndpoint(envReg, {
  at: now + 2000, status: 200,
  gateway: { endpointId: 'orcarouter-dsv4.1flash', upstreamModelId: 'deepseek/deepseek-v4.1-flash' },
  responseModel: 'deepseek-v4.1-flash', responseId: '021792223753404c323afa74840446e61be924aaf3459ee36dfc9',
  sessionId: SESSION, sessionIdSource: 'gateway', conversationBase: 'https://opencode.ai/zen/go',
})
await checks('I1 同一端点被折进一条记录，来源与 id 形态分桶计数', () => {
  const entry = envReg.endpoints.endpoints['manhattan-project']
  assert.equal(entry.count, 2)
  assert.equal(entry.sources.capture, 1)
  assert.equal(entry.sources.probe, 1)
  const model = entry.models['deepseek-v4.1-flash']
  assert.equal(model.idFamilies.gateway, 1)
  assert.equal(model.idFamilies['hex-native'], 1)
  assert.equal(model.upstreamModelIds['deepseek-v4.1-flash'], 2)
  assert.equal(model.contexts['https://opencode.ai/zen/go'], 1)
  assert.equal(entry.firstSeenAt, now)
  assert.equal(entry.lastSeenAt, now + 1000)
})
await checks('I2 不同端点各自成条 + lastContext 记到细节', () => {
  assert.equal(Object.keys(envReg.endpoints.endpoints).length, 2)
  const last = envReg.endpoints.endpoints['orcarouter-dsv4.1flash'].lastContext
  assert.equal(last.upstreamModelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(last.idFamily, 'hex-native')
  assert.equal(last.sessionIdSource, 'gateway')
})
await checks('I3 端点名缺失时兜底成占位，不丢数据', () => {
  const env2 = createEnv(stubCtx(), {})
  accumulateEndpoint(env2, { at: now, gateway: {}, responseModel: 'm', status: 200 })
  assert.ok(env2.endpoints.endpoints['(未命名端点)'], '应当归档到占位条目')
})
await checks('I4 没有网关证据的存证不污染登记表', () => {
  const env3 = createEnv(stubCtx(), {})
  assert.equal(accumulateEndpoint(env3, { at: now, fingerprint: 'x', status: 200 }), false)
  assert.equal(Object.keys(env3.endpoints.endpoints).length, 0)
})
await checks('I5 响应 id 形态分类', () => {
  assert.equal(responseIdFamily('gw-275c2fc21cdf-c79ec'), 'gateway')
  assert.equal(responseIdFamily('chatcmpl-465abc'), 'chatcmpl')
  assert.equal(responseIdFamily('a'.repeat(40)), 'hex-native')
  assert.equal(responseIdFamily('7e639ee5-1234-5678-9abc-def012345678'), 'uuid')
  assert.equal(responseIdFamily(undefined), 'unknown')
})
await checks('I6 extractResponseId 认 JSON 与 SSE 首个 id', () => {
  assert.equal(extractResponseId('{"id":"abc","model":"m"}'), 'abc')
  assert.equal(extractResponseId('data: {"id":"gw-1","object":"chat.completion.chunk"}\n\n'), 'gw-1')
  assert.equal(extractResponseId('no id here'), null)
})
await checks('I7 空登记表可继续加字段（schema 不封闭）', () => {
  const empty = emptyEndpointRegistry()
  empty.endpoints.x = { endpointId: 'x', identity: { name: '手工标注', category: 'vendor' } }
  assert.equal(empty.endpoints.x.identity.category, 'vendor')
})
await persistEndpoints(envReg)
const envReloaded = createEnv(stubCtx(), {})
await hydrateEndpoints(envReloaded)
await checks('I8 登记表落盘后跨重启读回，计数与上游串保住', () => {
  const manhattan = envReloaded.endpoints.endpoints['manhattan-project']
  assert.equal(manhattan.count, 2)
  assert.equal(manhattan.models['deepseek-v4.1-flash'].upstreamModelIds['deepseek-v4.1-flash'], 2)
  assert.equal(envReloaded.endpoints.endpoints['orcarouter-dsv4.1flash'].count, 1)
})
await persistEndpoints(envReg)
const registryOnDisk = JSON.parse(readFileSync(join(HOME, 'storages/system-fingerprint/endpoints.json'), 'utf8'))
await checks('I9 落盘文件自带版本号与用途说明（外部脚本可依赖）', () => {
  assert.equal(registryOnDisk.version, 1)
  assert.match(registryOnDisk.note, /持续累积/)
  assert.ok(registryOnDisk.endpoints['orcarouter-dsv4.1flash'])
})

// ── J. 请求头/响应头捕获（脱敏 + 限长） ─────────────────────────────────────
const envHdr = createEnv(stubCtx(), {})
const hdrTarget = captureTargetOf(envHdr, GW_URL, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk-should-not-be-stored',
    'X-Api-Key': 'also-secret',
    Cookie: 'session=secret',
    'content-type': 'application/json',
    'x-opencode-session': SESSION,
    'user-agent': 'deepseek-harness/0.2.0 (+https://github.com/deepseek-ai/deepseek-harness)',
    'x-long': 'z'.repeat(900),
  },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
})
await checks('J1 请求头被捕获且键名小写', () => {
  assert.ok(hdrTarget.requestHeaders, '应当捕获请求头')
  assert.equal(hdrTarget.requestHeaders['content-type'], 'application/json')
  assert.equal(hdrTarget.requestHeaders['x-opencode-session'], SESSION)
})
await checks('J2 凭据字段一律脱敏，绝不落盘', () => {
  const h = hdrTarget.requestHeaders
  assert.equal(h.authorization, '<redacted>')
  assert.equal(h['x-api-key'], '<redacted>')
  assert.equal(h.cookie, '<redacted>')
  assert.ok(!JSON.stringify(h).includes('should-not-be-stored'))
})
await checks('J3 超长头值被截断', () => {
  assert.ok(hdrTarget.requestHeaders['x-long'].length <= 513, '应截断到 512 + 省略号')
  assert.ok(hdrTarget.requestHeaders['x-long'].endsWith('…'))
})
await checks('J4 Headers 实例与二维数组都能读', () => {
  assert.deepEqual(headersToObject(new Headers({ 'User-Agent': 'ua/1' })), { 'user-agent': 'ua/1' })
  assert.deepEqual(headersToObject([['Content-Type', 'text/plain']]), { 'content-type': 'text/plain' })
  assert.deepEqual(headersToObject(undefined), {})
})
await checks('J5 init.headers 优先于 input.headers', () => {
  const picked = extractRequestHeaders({ headers: { 'x-from-input': '1' } }, { headers: { 'x-from-init': '2' } })
  assert.deepEqual(picked, { 'x-from-init': '2' })
})
await captureResponse(envHdr, new Response('{}', {
  status: 200,
  headers: { 'content-type': 'application/json', 'set-cookie': 'secret=1', 'x-opencode-endpoint-id': 'manhattan-project', 'cf-ray': 'abc-PDX' },
}), hdrTarget)
await checks('J6 存证里请求头与响应头成对落盘，响应头同样脱敏', () => {
  const entry = envHdr.entries[0]
  assert.equal(entry.requestHeaders['content-type'], 'application/json')
  assert.equal(entry.responseHeaders['x-opencode-endpoint-id'], 'manhattan-project')
  assert.equal(entry.responseHeaders['cf-ray'], 'abc-PDX')
  assert.equal(entry.responseHeaders['set-cookie'], '<redacted>')
})
await checks('J7 可以关掉头捕获（captureHeaders: false）', () => {
  const envOff = createEnv(stubCtx(), { captureHeaders: false })
  const t = captureTargetOf(envOff, GW_URL, { headers: { 'x-opencode-session': SESSION }, body: '{"model":"m"}' })
  assert.equal(t.requestHeaders, null)
})

// ── K. 隐私默认：原始字节默认不落盘，但证据/指纹照常 ───────────────────────
await checks('K1 默认配置的汇总里 rawEnabled=false 且标明 muting 原因', () => {
  const summary = captureSummaryOf(envHdr, SESSION)
  assert.equal(summary.enabled, true)
  assert.equal(summary.rawEnabled, false)
  assert.equal(summary.muting, 'capture-raw-disabled')
  assert.equal(summary.dir, null)
})
await checks('K2 默认配置下拦截到元数据，但不写 raw 文件（隐私默认）', async () => {
  const HOME2 = mkdtempSync(join(tmpdir(), 'fp-privacy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = HOME2
  try {
    const privacyEnv = createEnv(stubCtx(), {})
    const target = captureTargetOf(privacyEnv, GW_URL, {
      headers: { 'x-opencode-session': SESSION },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
    })
    const meta = await captureResponse(privacyEnv, new Response(gwBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-opencode-endpoint-id': 'orcarouter-dsv4.1flash' },
    }), target)
    assert.equal(meta.saved, false, '默认不应保存原始字节')
    assert.equal(meta.rawFile, null)
    assert.equal(meta.bytes > 0, true, '元数据里仍有字节数（不落盘）')
    assert.equal(meta.gateway.endpointId, 'orcarouter-dsv4.1flash', '网关证据仍要记录')
    assert.equal(privacyEnv.captureCount, 1)
    // raw 目录没有创建 / 没有文件
    await new Promise((resolve) => setTimeout(resolve, 50))
    let rawDirEntries = []
    try {
      rawDirEntries = readdirSync(join(HOME2, 'storages/system-fingerprint/raw'))
    } catch {
      rawDirEntries = []
    }
    assert.equal(rawDirEntries.length, 0, '默认配置不该产生 raw 文件')
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(HOME2, { recursive: true, force: true })
  }
})
await checks('K3 拦截总开关 capture:false 时完全不动（连探针响应都不拦）', () => {
  const offEnv = createEnv(stubCtx(), { capture: false })
  assert.equal(captureTargetOf(offEnv, GW_URL, {
    headers: { 'x-opencode-session': SESSION },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  }), null)
  const summary = captureSummaryOf(offEnv, SESSION)
  assert.equal(summary.enabled, false)
  assert.equal(summary.muting, 'capture-disabled')
})
await checks('K4 显式 captureRaw:true 时才落盘（跨版本默认语义）', async () => {
  const HOME3 = mkdtempSync(join(tmpdir(), 'fp-raw-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = HOME3
  try {
    const rawEnv = createEnv(stubCtx(), { captureRaw: true })
    const target = captureTargetOf(rawEnv, GW_URL, {
      headers: { 'x-opencode-session': SESSION },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
    })
    const meta = await captureResponse(rawEnv, new Response(gwBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-opencode-endpoint-id': 'manhattan-project' },
    }), target)
    assert.equal(meta.saved, true)
    assert.ok(readdirSync(join(HOME3, 'storages/system-fingerprint/raw')).length === 1)
    const summary = captureSummaryOf(rawEnv, SESSION)
    assert.equal(summary.rawEnabled, true)
    assert.equal(summary.muting, null)
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(HOME3, { recursive: true, force: true })
  }
})

// ── L. 供应商无关：自定义网关映射 / 自定义会话头 / 兜底 / 旧存证兼容 ────────
const customConfig = {
  provider: 'deepseek-official',
  gatewayHosts: ['gw.example.com'],
  gatewaySessionHeader: 'x-session-id',
  gatewayHeaders: {
    endpointId: 'x-upstream-provider',
    upstreamModelId: 'x-upstream-model',
    logId: 'x-request-id',
    zenModel: false,
    placement: false,
    rayId: false,
    cache: 'x-cache-status',
  },
}
const customEnv = createEnv(stubCtx(), { ...customConfig, captureRaw: true })
const customURL = 'https://gw.example.com/v1/chat/completions'
const customTarget = captureTargetOf(customEnv, customURL, {
  headers: { 'x-session-id': 'session-custom-1' },
  body: JSON.stringify({ model: 'vendor-model-1' }),
})
await captureResponse(customEnv, new Response(JSON.stringify({ id: 'x-1', model: 'vendor-model-1' }), {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-upstream-provider': 'reflection-ai',
    'x-upstream-model': 'vendor/model-1',
    'x-request-id': 'req-custom-1',
    'x-cache-status': 'MISS',
    'x-opencode-endpoint-id': 'should-not-be-read',
  },
}), customTarget)
const customState = await handleState(customEnv, stateReq('sessionId=session-custom-1&provider=other-gateway&model=vendor-model-1'))
await checks('L1 自定义网关：按配置的头取证据，未配置的默认头不读', () => {
  const entry = customEnv.entries[0]
  assert.equal(entry.gateway.endpointId, 'reflection-ai')
  assert.equal(entry.gateway.upstreamModelId, 'vendor/model-1')
  assert.equal(entry.gateway.logId, 'req-custom-1')
  assert.equal(entry.gateway.cache, 'MISS')
  assert.equal(entry.gateway.rayId, undefined)
})
await checks('L2 自定义网关：state 返回 gateway 模式，主显示与字段按配置顺序', () => {
  assert.equal(customState.ok, true)
  assert.equal(customState.value.displayKind, 'gateway')
  assert.equal(customState.value.display, 'reflection-ai')
  assert.deepEqual(customState.value.gateway.fields.map((field) => field.key), [
    'endpointId', 'upstreamModelId', 'logId', 'cache',
  ])
  assert.equal(customState.value.gateway.fields[3].value, 'MISS')
})
await checks('L3 没有 endpointId 角色时用第一个溯源字段当端点标识（登记表不断）', () => {
  const registryEnv = createEnv(stubCtx(), {})
  accumulateEndpoint(registryEnv, {
    at: Date.now(),
    status: 200,
    gateway: { fields: [{ key: 'provider', value: 'reflection-ai' }], provider: 'reflection-ai' },
    responseModel: 'vendor-model-1',
  })
  assert.ok(registryEnv.endpoints.endpoints['reflection-ai'], '应当用第一个字段值归档')
  assert.equal(registryEnv.endpoints.endpoints['reflection-ai'].lastContext.fields[0].key, 'provider')
})
await checks('L4 升级前的旧存证（gateway 无 fields）仍能按已知角色展示', async () => {
  const legacyEnv = createEnv(stubCtx(), {})
  legacyEnv.entries.push({
    at: Date.now(),
    kind: 'chat',
    origin: 'session',
    probe: false,
    purpose: null,
    sessionId: 'session-legacy-gw',
    sessionIdSource: 'gateway',
    requestModel: 'deepseek-v4.1-flash',
    responseModel: 'deepseek-v4.1-flash',
    fingerprint: null,
    gateway: { endpointId: 'legacy-pool', logId: 'legacy-log', source: 'headers' },
    traceId: 'legacy-log',
    saved: false,
    rawFile: null,
    bytes: 0,
    truncated: false,
  })
  const state = await handleState(legacyEnv, stateReq('sessionId=session-legacy-gw&provider=opencode-go&model=deepseek-v4.1-flash'))
  assert.equal(state.value.displayKind, 'gateway')
  assert.equal(state.value.display, 'legacy-pool')
  const keys = state.value.gateway.fields.map((field) => field.key)
  assert.ok(keys.includes('endpointId'))
  assert.ok(keys.includes('logId'))
})
await checks('L5 gatewayHeaders:false 时自定义 provider 仍走「不适用」，不伪造溯源', async () => {
  const offEnv = createEnv(stubCtx(), { gatewayHeaders: false, gatewayHosts: ['gw.example.com'] })
  const target = captureTargetOf(offEnv, customURL, {
    headers: { 'x-opencode-session': SESSION },
    body: JSON.stringify({ model: 'vendor-model-1' }),
  })
  const meta = await captureResponse(offEnv, new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-opencode-endpoint-id': 'should-not-be-read' },
  }), target)
  assert.equal(meta.gateway, null)
  const state = await handleState(offEnv, stateReq('sessionId=session-gateway-off&provider=opencode-go&model=deepseek-v4.1-flash'))
  assert.equal(state.value.supported, false)
  assert.equal(state.value.reason, 'provider-not-probeable')
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
rmSync(HOME, { recursive: true, force: true })
const failed = results.filter((row) => row[0] === 'FAIL')
for (const [status, name, message] of results) {
  console.log(`${status === 'PASS' ? '  ✓' : '  ✗'} ${name}${message ? ` — ${message}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
