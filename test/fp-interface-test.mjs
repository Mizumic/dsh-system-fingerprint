// 对外接口契约验收（docs/INTERFACE.md 的可执行版本）。
//
// 覆盖：
//   A. HTTP 状态接口 v1：所有形态都带 apiVersion；错误码形状稳定
//   B. config.json v1：字段白名单、无凭据/无绝对路径、checkpoint 绑定、原子落盘
//   C. 单向依赖：插件代码零 driftmon 引用；插件只写自己的存储目录
//   D. 文档/版本同步：PLUGIN_VERSION == package.json version；INTERFACE/README 互相引用
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => readFileSync(join(ROOT, name), 'utf8')
const manifest = JSON.parse(read('package.json'))
const interfaceDoc = read('docs/INTERFACE.md')
const readme = read('README.md')
const hostSource = read('lib/index.js')
const clientSource = read('lib/client.js')

const { _internals } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const {
  API_VERSION, CONFIG_EXPORT_VERSION, CONFIG_EXPORT_FILE, PLUGIN_VERSION,
  captureResponse, configExportOf, createEnv, handleState, persistConfigExport, storagePaths,
} = _internals

const results = []
const run = async (name, fn) => {
  try {
    await fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}
const stubCtx = () => ({ get: () => undefined })
const stateReq = (query) => new Request(`http://localhost/api/system-fingerprint/state?${query}`)

// 每个检查独占临时 DSH_HOME，避免相互污染。
const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'fp-iface-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

// ── A. HTTP 状态接口 v1 ─────────────────────────────────────────────────────
await run('A1 指纹可用形态带 apiVersion=1 与 displayKind=checkpoint', async () => {
  await withHome(async () => {
    const env = createEnv(stubCtx(), {})
    const target = {
      kind: 'chat',
      path: '/chat/completions',
      requestUrl: 'https://api.deepseek.com/chat/completions',
      conversationBase: 'https://api.deepseek.com',
      sessionId: 'session-iface-1',
      probe: false,
      requestModel: 'deepseek-flash',
      purpose: null,
    }
    await captureResponse(env, new Response(JSON.stringify({
      model: 'deepseek-flash',
      system_fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
    }), { status: 200 }), target)
    const response = await handleState(env, stateReq('sessionId=session-iface-1&provider=deepseek-official&model=deepseek-flash'))
    assert.equal(response.apiVersion, 1)
    assert.equal(API_VERSION, 1)
    assert.equal(response.ok, true)
    assert.equal(response.value.displayKind, 'checkpoint')
    assert.equal(response.value.display, 'flash 1017')
  })
})

await run('A2 网关溯源形态带 apiVersion=1 与 gateway.fields', async () => {
  await withHome(async () => {
    const env = createEnv(stubCtx(), { gatewayHosts: ['gw.example.com'] })
    env.entries.push({
      at: Date.now(),
      kind: 'chat',
      origin: 'session',
      probe: false,
      purpose: null,
      sessionId: 'session-iface-gw',
      sessionIdSource: 'gateway',
      requestModel: 'm-1',
      responseModel: 'm-1',
      fingerprint: null,
      gateway: { endpointId: 'pool-a', logId: 'log-a', fields: [{ key: 'endpointId', value: 'pool-a' }, { key: 'logId', value: 'log-a' }] },
      saved: false,
      rawFile: null,
      bytes: 0,
      truncated: false,
    })
    const response = await handleState(env, stateReq('sessionId=session-iface-gw&provider=other-gw&model=m-1'))
    assert.equal(response.apiVersion, 1)
    assert.equal(response.value.displayKind, 'gateway')
    assert.equal(response.value.display, 'pool-a')
    assert.deepEqual(response.value.gateway.fields.map((field) => field.key), ['endpointId', 'logId'])
  })
})

await run('A3 不在探测范围 / 探测失败两种降级形态都带 apiVersion', async () => {
  await withHome(async () => {
    const unsupported = createEnv(stubCtx(), {})
    const res1 = await handleState(unsupported, stateReq('provider=aliyun-bailian&model=glm-5.3'))
    assert.equal(res1.apiVersion, 1)
    assert.equal(res1.value.reason, 'provider-not-probeable')

    // 凭据缺失：用不存在的 env 名，保证不联网、错误码稳定。
    const noCred = createEnv(stubCtx(), { apiKeyEnv: 'FP_INTERFACE_TEST_MISSING_KEY' })
    const res2 = await handleState(noCred, stateReq('sessionId=session-none&provider=deepseek-official&model=deepseek-flash'))
    assert.equal(res2.apiVersion, 1)
    assert.equal(res2.ok, false)
    assert.equal(res2.error.code, 'missing-credential')
    assert.equal(typeof res2.error.message, 'string')
  })
})

await run('A4 响应里的 capture 子对象把「元数据拦截」与「原始字节」分开', async () => {
  await withHome(async () => {
    const env = createEnv(stubCtx(), {})
    const response = await handleState(env, stateReq('provider=aliyun-bailian&model=glm-5.3'))
    const capture = response.value.capture
    assert.equal(capture.enabled, true)
    assert.equal(capture.rawEnabled, false, '分发默认不应落原始字节')
    assert.equal(capture.headersEnabled, true)
    assert.equal(capture.muting, 'capture-raw-disabled')
  })
})

await run('A5 可选外部告警文件：合法时挂在 state 顶层，缺失/损坏都降级为 null', async () => {
  await withHome(async (home) => {
    const alertFile = join(home, 'gray-watch.json')
    const alertPayload = {
      version: 1,
      kind: 'behavior-watch',
      level: 'warn',
      verdict: 'gray-candidate',
      updatedAt: 1792435200000,
      message: '指纹未变但行为通道偏移（G）：疑似灰度',
      subject: { provider: 'deepseek-official', model: 'deepseek-flash', checkpoint: { name: 'flash 1017', fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' } },
      signals: [{ channel: 'G', verdict: 'changed', detail: '失败率偏移 20.0 个百分点' }],
      caveats: ['需要连续复现'],
    }
    writeFileSync(alertFile, JSON.stringify(alertPayload), 'utf8')
    const env = createEnv(stubCtx(), { externalAlertFile: alertFile })
    const response = await handleState(env, stateReq('provider=aliyun-bailian&model=glm-5.3'))
    assert.equal(response.apiVersion, 1)
    assert.equal(response.alert.level, 'warn')
    assert.equal(response.alert.verdict, 'gray-candidate')
    assert.equal(response.alert.subject.checkpoint.fingerprint, 'e72d3c7f663d3e1383b00b3884cb4501')
    assert.equal(response.alert.signals[0].channel, 'G')
    assert.equal(configExportOf(env).alerts.enabled, true)

    // 损坏文件 / 版本不认识 → 降级 null，不抛错
    writeFileSync(alertFile, '{ not json', 'utf8')
    const corrupted = createEnv(stubCtx(), { externalAlertFile: alertFile })
    assert.equal((await handleState(corrupted, stateReq('provider=aliyun-bailian&model=glm-5.3'))).alert, null)
    writeFileSync(alertFile, JSON.stringify({ ...alertPayload, version: 99 }), 'utf8')
    const future = createEnv(stubCtx(), { externalAlertFile: alertFile })
    assert.equal((await handleState(future, stateReq('provider=aliyun-bailian&model=glm-5.3'))).alert, null)

    // 未配置 → null；config.json 导出只暴露 enabled 布尔
    const plain = createEnv(stubCtx(), {})
    assert.equal((await handleState(plain, stateReq('provider=aliyun-bailian&model=glm-5.3'))).alert, null)
    assert.equal(configExportOf(plain).alerts.enabled, false)
  })
})

// ── B. config.json v1 ──────────────────────────────────────────────────────
await run('B1 导出字段齐全、版本正确、无凭据/无绝对路径', async () => {
  await withHome(async (home) => {
    const env = createEnv(stubCtx(), {})
    const exported = configExportOf(env)
    const text = JSON.stringify(exported)
    assert.equal(exported.version, 1)
    assert.equal(CONFIG_EXPORT_VERSION, 1)
    assert.equal(CONFIG_EXPORT_FILE, 'config.json')
    assert.equal(exported.plugin.name, 'dsh-system-fingerprint')
    assert.equal(exported.plugin.stateApiVersion, 1)
    assert.equal(exported.probe.provider, 'deepseek-official')
    assert.equal(exported.probe.apiKeyEnv, 'DEEPSEEK_API_KEY', '只导出凭据 ref 的名字')
    assert.equal(exported.capture.rawEnabled, false)
    assert.ok(Array.isArray(exported.gateway.headers) && exported.gateway.headers[0].header === 'x-opencode-endpoint-id')
    assert.ok(exported.checkpoints.every((entry) => Object.keys(entry).sort().join(',') === 'fingerprint,name'))
    assert.equal(text.includes(home), false, '不应把绝对 DSH_HOME 写进契约文件')
    assert.equal(/Bearer\s|sk-[A-Za-z0-9]{10,}/u.test(text), false, '不应出现凭据值')
  })
})

await run('B2 探测成功后 checkpoint 绑定到 flash 1017（供行为模板对齐）', async () => {
  await withHome(async () => {
    const env = createEnv(stubCtx(), {})
    assert.equal(configExportOf(env).checkpoint, null)
    env.lastProbe = {
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      systemFingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
      at: 1792427000000,
      endpointHost: 'api.deepseek.com',
      confidence: 'high',
    }
    const exported = configExportOf(env)
    assert.equal(exported.checkpoint.fingerprint, 'e72d3c7f663d3e1383b00b3884cb4501')
    assert.equal(exported.checkpoint.name, 'flash 1017')
    assert.equal(exported.checkpoint.endpointHost, 'api.deepseek.com')
  })
})

await run('B3 persistConfigExport 原子落盘到约定路径', async () => {
  await withHome(async (home) => {
    const env = createEnv(stubCtx(), {})
    await persistConfigExport(env)
    const path = join(home, 'storages/system-fingerprint/config.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.plugin.name, 'dsh-system-fingerprint')
    assert.deepEqual(storagePaths().config, path)
  })
})

// ── C. 单向依赖 / 职责边界 ────────────────────────────────────────────────
await run('C1 插件代码零 driftmon 引用（单向依赖）', () => {
  assert.equal(/driftmon/iu.test(hostSource), false, 'lib/index.js 不应出现 driftmon 引用')
  assert.equal(/driftmon/iu.test(clientSource), false, 'lib/client.js 不应出现 driftmon 引用')
  // 宿主不得 import 任何非 Node 内建模块（避免把外部采集器/插件当依赖）。
  const imports = [...hostSource.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((name) => name.startsWith('node:')), `出现非内建 import：${imports.join(', ')}`)
})

await run('C2 插件只写自己的存储目录（storagePaths 全部在 storages/system-fingerprint 下）', async () => {
  await withHome(async (home) => {
    const paths = storagePaths()
    const root = join(home, 'storages/system-fingerprint')
    assert.equal(paths.root, root)
    for (const key of ['raw', 'meta', 'endpoints', 'config']) {
      assert.ok(paths[key].startsWith(root + '/'), `${key} 应位于插件存储目录内`)
    }
  })
})

// ── D. 文档 / 版本同步 ────────────────────────────────────────────────────
await run('D1 PLUGIN_VERSION 与 package.json 版本一致', () => {
  assert.equal(PLUGIN_VERSION, manifest.version, '改版本时 lib/index.js 的 PLUGIN_VERSION 要同步')
})

await run('D2 INTERFACE 文档覆盖三类契约与版本策略，README 有入口', () => {
  for (const needle of ['HTTP 状态接口（v1）', 'endpoints.json', 'config.json', '版本与变更流程', '只读导出，不含凭据']) {
    assert.ok(interfaceDoc.includes(needle), `docs/INTERFACE.md 缺 ${needle}`)
  }
  assert.ok(readme.includes('docs/INTERFACE.md'), 'README 应链接接口契约')
  assert.ok(manifest.files.includes('docs'), 'package.json 的 files 应包含 docs（随包分发契约）')
})

const failed = results.filter((row) => row[0] === 'FAIL')
for (const [status, name, message] of results) {
  console.log(`${status === 'PASS' ? '  ✓' : '  ✗'} ${name}${message ? ` — ${message}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
