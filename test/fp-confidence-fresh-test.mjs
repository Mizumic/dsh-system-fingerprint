#!/usr/bin/env node
/**
 * 回归：徽标的「同层可信度」必须按**当前**观测重算，不能用探测开始那一刻的旧结论。
 *
 * 这几条路径都不报错、只会让徽标停在警示色，所以用会大声失败的断言钉住：
 *   1) 60s 缓存命中：探测发生在观测建立之前（low/config），命中后来源已升级成 observed，
 *      结论也必须跟着变成 high —— 否则点击/刷新后仍显示黄色，等到缓存过期才恢复。
 *   2) 慢探测晚落地：它比「点击强制刷新」的那次探测更旧，不许把旧结论写回缓存。
 *   3) 会话端点换了：旧探测不能再冒充「本会话同源根」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-fp-fresh-'))
process.env.DSH_HOME = home

const fingerprint = 'bc19ba97cbe016479903222bb1578db6'
const observedBase = 'https://api.deepseek.com'
let fetchMode = 'fast'
globalThis.fetch = async () => {
  const mode = fetchMode
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 250))
  return new Response(
    JSON.stringify({ id: 'chatcmpl-test', model: 'deepseek-flash', system_fingerprint: fingerprint }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const { _internals: I } = await import(new URL('../lib/index.js', import.meta.url).href)

const QUERY = 'sessionId=s1&provider=deepseek-official&model=deepseek-flash'
const stateRequest = (query = QUERY) => new Request(`http://localhost/api/system-fingerprint/state?${query}`)
const newEnv = () => I.createEnv({ get: () => ({ resolve: async () => ({ value: 'test-key' }) }) }, {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  openaiBaseURL: observedBase,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  stabilityChecks: 1,
  cacheTtlMs: 60000,
  errorTtlMs: 10000,
})
const observeSession = (env) => env.lastRequestBySession.set('s1', {
  at: Date.now(),
  requestUrl: `${observedBase}/anthropic/v1/messages`,
  conversationBase: observedBase,
  requestModel: 'deepseek-flash',
})
const view = async (promise) => {
  const body = await promise
  const value = body.value ?? {}
  return {
    confidence: value.confidence,
    endpointSource: value.endpoint?.source,
    cached: value.cached,
    note: value.confidenceNote,
  }
}

let failures = 0
async function check (name, run) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  // 1) 缓存命中必须重算可信度
  await check('缓存命中：观测晚到后 confidence 从 low 升到 high', async () => {
    fetchMode = 'fast'
    const env = newEnv()
    const first = await view(I.handleState(env, stateRequest()))
    assert.equal(first.confidence, 'low', '无观测的首次探测应为 low')
    assert.equal(first.endpointSource, 'config', '无观测的首次探测应来自配置端点')

    observeSession(env)
    const hit = await view(I.handleState(env, stateRequest()))
    assert.equal(hit.cached, true, '第二次取数应命中 60s 缓存')
    assert.equal(hit.endpointSource, 'observed', '命中缓存也要把端点来源修正成同源根')
    assert.equal(hit.confidence, 'high', '端点已是同源根，可信度必须重算成 high（否则徽标一直黄）')
    assert.ok(hit.note.includes('同源根'), `可信度说明应与结论一致，实际：${hit.note}`)
  })

  // 2) 慢探测晚落地不能覆盖更新的点击结果
  await check('慢探测晚落地：不覆盖点击后的新结果', async () => {
    const env = newEnv()
    fetchMode = 'slow'
    const stale = I.handleState(env, stateRequest()) // 观测建立前开始，慢
    await new Promise((resolve) => setTimeout(resolve, 30))
    observeSession(env)
    fetchMode = 'fast'
    const clicked = await view(I.handleState(env, stateRequest(`${QUERY}&refresh=1`)))
    assert.equal(clicked.confidence, 'high', '点击强制刷新的结果应为 high')
    await stale.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = await view(I.handleState(env, stateRequest()))
    assert.equal(after.confidence, 'high', `慢探测落地后仍须是 high，实际 ${after.confidence}`)
  })

  // 3) 会话端点变化后不许冒充同源
  await check('会话端点变更：不再声称 observed', async () => {
    fetchMode = 'fast'
    const env = newEnv()
    observeSession(env)
    const res = await I.handleState(env, stateRequest())
    const endpoint = res.value.endpoint
    const reassessed = I.reassessProbe(env, { sessionId: 's1', model: 'deepseek-flash', provider: 'deepseek-official' }, {
      endpoint: { ...endpoint, baseURL: 'https://other.example.com', host: 'other.example.com', source: 'observed' },
      confidence: 'high',
      confidenceNote: 'stale',
    })
    assert.notEqual(reassessed.endpoint.source, 'observed', '端点已不同于会话同源根，source 必须降级')
    assert.notEqual(reassessed.confidence, 'high', '不同源的探测不能算 high')
  })
} finally {
  await rm(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
