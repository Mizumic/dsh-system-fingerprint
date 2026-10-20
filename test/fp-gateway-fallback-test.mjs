// 网关端点标识缺失（上游不披露端点）时的降级与迁移验收（离线，不起 dsh 进程）。
//
// 背景：2026-10-20 起 OpenCode Go 不再返回 `x-opencode-endpoint-id` / `x-opencode-upstream-model-id`。
// 旧兜底会把逐请求的 log-id（UUID）当端点标识，导致：
//   * 徽标显示成 UUID；
//   * 端点登记表「一请求一个假端点」；
// 本文件锁定修复后的行为：
//   A. 缺 endpointId 头 → 落 `(端点未披露)` 固定桶，绝不产生 UUID 键，多次请求合并计数
//   B. 自定义角色字段（非默认六角色）仍按老行为当端点标识
//   C. 配置里没有 endpointId 角色时，保留「第一个溯源字段」兜底
//   D. 徽标主显示：endpointId → 自定义字段 → zenModel → 「网关·<落点>」
//   E. state 里的 gateway.endpointDisclosed 标记
//   F. 启动 hydrate 把历史 UUID 假条目并进固定桶（幂等）
//   G. 官方 DeepSeek 存证（gateway 为 null）不受影响
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = mkdtempSync(join(tmpdir(), 'fp-fallback-'))
process.env.DSH_HOME = HOME

const { _internals } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { createEnv, accumulateEndpoint, valueOfGateway, hydrateEndpoints, persistEndpoints } = _internals

const stubCtx = () => ({ get: () => undefined })
const SESSION = 'session-4a931228-09e0-41a7-8f97-3e459c4047d9'
const UUID_A = '01a157be-deaa-73f1-98fa-33015fccec05'
const UUID_B = '01a157bf-47d1-7d61-8044-90466e54cb88'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/u

const results = []
const run = async (name, fn) => {
  try {
    await fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}

/** 模拟 2026-10-20 的真实响应头：只有 zenModel/logId/placement/rayId。 */
const gatewayMissingEndpoint = (logId) => ({
  zenModel: 'deepseek-v4.1-flash',
  logId,
  placement: 'remote-IAD',
  rayId: 'a4d58f69a80703c2-SJC',
  fields: [
    { key: 'zenModel', header: 'x-zen-model', value: 'deepseek-v4.1-flash' },
    { key: 'logId', header: 'x-opencode-log-id', value: logId },
    { key: 'placement', header: 'cf-placement', value: 'remote-IAD' },
    { key: 'rayId', header: 'cf-ray', value: 'a4d58f69a80703c2-SJC' },
  ],
})
const metaMissingEndpoint = (logId, at) => ({
  at,
  status: 200,
  gateway: gatewayMissingEndpoint(logId),
  responseModel: 'deepseek-v4.1-flash',
  requestModel: 'deepseek-v4.1-flash',
  conversationBase: 'https://opencode.ai/zen/go',
  path: '/zen/go/v1/chat/completions',
  sessionId: SESSION,
  sessionIdSource: 'gateway',
  responseId: '0217924738',
})
const fakeHit = (gateway) => ({
  matchedBy: 'session',
  entry: {
    at: 1792473500000,
    gateway,
    conversationBase: 'https://opencode.ai/zen/go',
    path: '/zen/go/v1/chat/completions',
    responseModel: 'deepseek-v4.1-flash',
    requestModel: 'deepseek-v4.1-flash',
    sessionId: SESSION,
    sessionIdSource: 'gateway',
  },
})
const TARGET = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', source: 'config' }

// ── A. 缺端点标识：固定桶 + 不产生 UUID 假端点 ────────────────────────────────
await run('A1 缺 endpointId 时落固定桶，多次请求合并计数', () => {
  const env = createEnv(stubCtx(), {})
  accumulateEndpoint(env, metaMissingEndpoint(UUID_A, 1000))
  accumulateEndpoint(env, metaMissingEndpoint(UUID_B, 2000))
  const keys = Object.keys(env.endpoints.endpoints)
  assert.deepEqual(keys, ['(端点未披露)'], `期望只有固定桶，实际 ${keys.join(', ')}`)
  const bucket = env.endpoints.endpoints['(端点未披露)']
  assert.equal(bucket.count, 2)
  assert.equal(bucket.firstSeenAt, 1000)
  assert.equal(bucket.lastSeenAt, 2000)
  assert.equal(bucket.models['deepseek-v4.1-flash'].count, 2)
  assert.ok(!keys.some((key) => UUID_RE.test(key)), '登记表里绝不能出现 UUID 形态 key')
})

await run('A2 固定桶里保留可用的近似溯源信息（但明确不是池名）', () => {
  const env = createEnv(stubCtx(), {})
  accumulateEndpoint(env, metaMissingEndpoint(UUID_A, 1000))
  const last = env.endpoints.endpoints['(端点未披露)'].lastContext
  assert.equal(last.zenModel, 'deepseek-v4.1-flash')
  assert.equal(last.placement, 'remote-IAD')
  assert.equal(last.logId, UUID_A)
  assert.equal(env.endpoints.endpoints['(端点未披露)'].endpointId, '(端点未披露)')
})

// ── B. 自定义角色字段仍是端点标识 ─────────────────────────────────────────────
await run('B1 第一个字段是自定义角色（如 provider）时沿用它当端点标识', () => {
  const env = createEnv(stubCtx(), {})
  accumulateEndpoint(env, {
    at: 1000,
    status: 200,
    gateway: { fields: [{ key: 'provider', value: 'reflection-ai' }], provider: 'reflection-ai' },
    responseModel: 'vendor-model-1',
  })
  assert.ok(env.endpoints.endpoints['reflection-ai'], '自定义角色字段应继续当端点标识')
})

// ── C. 配置没有 endpointId 角色：保留老兜底 ──────────────────────────────────
await run('C1 配置去掉 endpointId 角色时用第一个溯源字段兜底', () => {
  const env = createEnv(stubCtx(), { gatewayHeaders: { endpointId: false, logId: 'x-request-id' } })
  accumulateEndpoint(env, {
    at: 1000,
    status: 200,
    gateway: { logId: 'req-abc-123', fields: [{ key: 'logId', header: 'x-request-id', value: 'req-abc-123' }] },
    responseModel: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(Object.keys(env.endpoints.endpoints), ['req-abc-123'])
})

// ── D. 徽标主显示降级 ─────────────────────────────────────────────────────────
await run('D1 缺端点标识时徽标显示模型别名，不显示 log-id UUID', () => {
  const env = createEnv(stubCtx(), {})
  const value = valueOfGateway(env, TARGET, fakeHit(gatewayMissingEndpoint(UUID_A))).value
  assert.equal(value.display, 'deepseek-v4.1-flash')
  assert.equal(value.gateway.endpointDisclosed, false)
})

await run('D2 模型别名也缺时显示「网关·<边缘落点>」', () => {
  const env = createEnv(stubCtx(), {})
  const gateway = {
    logId: UUID_A,
    placement: 'remote-IAD',
    fields: [
      { key: 'logId', header: 'x-opencode-log-id', value: UUID_A },
      { key: 'placement', header: 'cf-placement', value: 'remote-IAD' },
    ],
  }
  const value = valueOfGateway(env, TARGET, fakeHit(gateway)).value
  assert.equal(value.display, '网关·remote-IAD')
  assert.equal(value.gateway.endpointDisclosed, false)
})

await run('D3 上游恢复端点标识时优先显示池名并标记 disclosed', () => {
  const env = createEnv(stubCtx(), {})
  const gateway = {
    endpointId: 'orcarouter-dsv4.1flash',
    zenModel: 'deepseek-v4.1-flash',
    logId: UUID_A,
    fields: [
      { key: 'endpointId', header: 'x-opencode-endpoint-id', value: 'orcarouter-dsv4.1flash' },
      { key: 'zenModel', header: 'x-zen-model', value: 'deepseek-v4.1-flash' },
      { key: 'logId', header: 'x-opencode-log-id', value: UUID_A },
    ],
  }
  const value = valueOfGateway(env, TARGET, fakeHit(gateway)).value
  assert.equal(value.display, 'orcarouter-dsv4.1flash')
  assert.equal(value.gateway.endpointDisclosed, true)
})

// ── E. state 里的标记可被 UI 消费 ────────────────────────────────────────────
await run('E1 gateway.endpointDisclosed 进入 state value，供前端提示降级', () => {
  const env = createEnv(stubCtx(), {})
  const value = valueOfGateway(env, TARGET, fakeHit(gatewayMissingEndpoint(UUID_A))).value
  assert.equal(value.gateway.endpointDisclosed, false)
  assert.equal(value.value, undefined)
  assert.equal(value.displayKind, 'gateway')
})

// ── F. 历史污染迁移（幂等） ───────────────────────────────────────────────────
const fakeEndpoint = (id, at, count) => ({
  endpointId: id,
  firstSeenAt: at,
  lastSeenAt: at + 1000,
  count,
  sources: { capture: count },
  models: {
    'deepseek-v4.1-flash': {
      count,
      firstSeenAt: at,
      lastSeenAt: at + 1000,
      upstreamModelIds: {},
      idFamilies: { uuid: count },
      contexts: { 'https://opencode.ai/zen/go': count },
    },
  },
  lastContext: { at, logId: id, status: 200, fields: [] },
})

await run('F1 hydrate 把历史 UUID 假条目并进固定桶', async () => {
  const storage = join(HOME, 'storages/system-fingerprint')
  mkdirSync(storage, { recursive: true })
  const payload = {
    version: 1,
    updatedAt: 1,
    endpoints: {
      'orcarouter-dsv4.1flash': { ...fakeEndpoint('orcarouter-dsv4.1flash', 1000, 5), lastContext: { at: 1000 } },
      [UUID_A]: fakeEndpoint(UUID_A, 2000, 2),
      [UUID_B]: fakeEndpoint(UUID_B, 3000, 3),
    },
  }
  writeFileSync(join(storage, 'endpoints.json'), JSON.stringify(payload))
  const env = createEnv(stubCtx(), {})
  await hydrateEndpoints(env)
  const keys = Object.keys(env.endpoints.endpoints).sort()
  assert.deepEqual(keys, ['(端点未披露)', 'orcarouter-dsv4.1flash'], `UUID 应被合并，实际 ${keys.join(', ')}`)
  const bucket = env.endpoints.endpoints['(端点未披露)']
  assert.equal(bucket.count, 5, `合并计数应为 2+3=5，实际 ${bucket.count}`)
  assert.equal(bucket.firstSeenAt, 2000)
  assert.equal(bucket.lastSeenAt, 4000)
  assert.equal(bucket.models['deepseek-v4.1-flash'].count, 5)
})

await run('F2 迁移幂等：重复 hydrate 不重复计数，并落盘', async () => {
  const env = createEnv(stubCtx(), {})
  await hydrateEndpoints(env)
  await hydrateEndpoints(env)
  assert.equal(env.endpoints.endpoints['(端点未披露)'].count, 5, '重复 hydrate 不应累加')
  await persistEndpoints(env)
  const saved = JSON.parse(readFileSync(join(HOME, 'storages/system-fingerprint/endpoints.json'), 'utf8'))
  assert.ok(saved.endpoints['(端点未披露)'], '迁移结果应已落盘')
  assert.ok(!Object.keys(saved.endpoints).some((key) => UUID_RE.test(key)), '落盘后不应再有 UUID 键')
})

await run('F3 旧兜底产生的角色值键（如 remote-IAD）也并入固定桶', async () => {
  const storage = join(HOME, 'storages/system-fingerprint')
  const payload = {
    version: 1,
    updatedAt: 1,
    endpoints: {
      'orcarouter-dsv4.1flash': { ...fakeEndpoint('orcarouter-dsv4.1flash', 1000, 5), lastContext: { at: 1000 } },
      'remote-IAD': {
        endpointId: 'remote-IAD',
        firstSeenAt: 5000,
        lastSeenAt: 5000,
        count: 1,
        sources: { capture: 1 },
        models: { 'deepseek-v4.1-flash': { count: 1, firstSeenAt: 5000, lastSeenAt: 5000, upstreamModelIds: {}, idFamilies: {}, contexts: {} } },
        // 只有 placement/rayId，没有 endpointId 头 → 旧兜底把 placement 值当成了键
        lastContext: { at: 5000, fields: [{ key: 'placement', value: 'remote-IAD' }, { key: 'rayId', value: 'a4d5-SJC' }] },
      },
    },
  }
  writeFileSync(join(storage, 'endpoints.json'), JSON.stringify(payload))
  const env = createEnv(stubCtx(), {})
  await hydrateEndpoints(env)
  const keys = Object.keys(env.endpoints.endpoints).sort()
  assert.deepEqual(keys, ['(端点未披露)', 'orcarouter-dsv4.1flash'], `角色值键应被合并，实际 ${keys.join(', ')}`)
  assert.equal(env.endpoints.endpoints['(端点未披露)'].count, 1)
})

// ── G. 官方 DeepSeek 存证（gateway 为 null）不受影响 ─────────────────────────
await run('G1 无网关证据的存证不写登记表（官方 DS 指纹路径不受影响）', () => {
  const env = createEnv(stubCtx(), {})
  const before = JSON.stringify(env.endpoints)
  assert.equal(accumulateEndpoint(env, { at: 1, gateway: null, responseModel: 'deepseek-flash' }), false)
  assert.equal(JSON.stringify(env.endpoints), before)
})

rmSync(HOME, { recursive: true, force: true })
const failed = results.filter((row) => row[0] === 'FAIL')
for (const [status, name, message] of results) {
  console.log(`${status === 'PASS' ? '  ✓' : '  ✗'} ${name}${message ? ` — ${message}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
