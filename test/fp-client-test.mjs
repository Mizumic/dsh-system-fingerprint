// dsh-system-fingerprint 浏览器半边离线自测：
// 直接抽取 bundle 里的 buildPanelContent / panelPlacement 真实源码执行，
// 验证悬浮卡片是「标签/值两列、每条一行」，而不是把一堆信息堆在一行。
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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

/** 按大括号配对从源码里切出一个函数定义（测试用：执行的就是 bundle 里的真实源码）。 */
function extractFunction (name) {
  const start = SRC.indexOf(`function ${name} `)
  if (start < 0) throw new Error(`function ${name} not found`)
  const braceStart = SRC.indexOf('{', start)
  let depth = 0
  for (let index = braceStart; index < SRC.length; index += 1) {
    if (SRC[index] === '{') depth += 1
    else if (SRC[index] === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced ${name}`)
}

/** 从源码里取 zh/en 词典字面量。 */
function extractDict (name) {
  const match = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n    \\})`, 'm').exec(SRC)
  if (!match) throw new Error(`dict ${name} not found`)
  return new Function(`return (${match[1]})`)()
}

const zh = extractDict('zh')
const en = extractDict('en')
const t = (key) => (zh[key] !== undefined ? zh[key] : key)

globalThis.window = { innerWidth: 1280, innerHeight: 900 }

// pad 是箭头常量，单独抽出来
const padMatch = /const pad = \(n\) => [^\n]+/.exec(SRC)
if (!padMatch) throw new Error('pad helper not found')

const factory = new Function(`
${padMatch[0]}
${extractFunction('formatTime')}
${extractFunction('formatAge')}
${extractFunction('errorText')}
${extractFunction('captureText')}
${extractFunction('buildPanelContentBase')}
${extractFunction('appendAlertRows')}
${extractFunction('buildPanelContent')}
${extractFunction('badgeOfBase')}
${extractFunction('badgeOf')}
${extractFunction('panelPlacement')}
return { buildPanelContent, panelPlacement, badgeOf, formatTime, formatAge }
`)
const lib = factory()

// ── 1) loading / error / unsupported 不崩 ──────────────────────────────
const loading = lib.buildPanelContent(t, { kind: 'loading' })
check('loading rows', loading.rows.length === 1 && loading.rows[0].label === '状态')
const errored = lib.buildPanelContent(t, { kind: 'error', error: { code: 'timeout', message: 'probe timed out' } })
check('error rows', errored.rows.length === 1 && errored.rows[0].label === '错误' && errored.rows[0].value.includes('超时'))
check('error note', errored.notes.includes('probe timed out'))
const unsupported = lib.buildPanelContent(t, { kind: 'value', value: { supported: false, provider: 'aliyun-bailian', requestedModel: 'glm-5.3', note: '仅对 deepseek-official 路由探测' } })
check('unsupported rows', unsupported.rows.length === 1 && unsupported.rows[0].value === 'aliyun-bailian / glm-5.3')
check('unsupported notes', unsupported.notes.length === 2)

// ── 2) 正常指纹：信息必须拆成多行（标签/值两列） ─────────────────────
const value = {
  supported: true,
  provider: 'deepseek-official',
  requestedModel: 'deepseek-flash',
  model: 'deepseek-flash',
  systemFingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
  fingerprintSource: 'probe',
  display: 'flash 1017',
  displayKind: 'checkpoint',
  checkpoint: { name: 'flash 1017', plaintext: 'fp_dsv41f_1017_prod0820_fp8_kvcache_20260402_fp' },
  probedAt: 1792219762972,
  ageMs: 12000,
  traceId: 'b063a38b0bb068a5625d090de2c5740a',
  stable: true,
  checks: 2,
  cached: false,
  stale: false,
  fingerprintSource2: undefined,
  confidence: 'high',
  confidenceNote: '探测端点取自本会话真实请求的同源根，并带上会话头，尽量走同一层',
  endpoint: {
    host: 'gw.example.com',
    source: 'observed',
    conversationHost: 'gw.example.com',
    sessionHeaderForwarded: true,
  },
  capture: {
    enabled: true,
    total: 72,
    last: { at: 1792219759000, kind: 'messages', truncated: false },
  },
}
const panel = lib.buildPanelContent(t, { kind: 'value', value })
const labels = panel.rows.map((row) => row.label)
const values = panel.rows.map((row) => row.value)
check('panel has many distributed rows', panel.rows.length >= 10, String(panel.rows.length))
check('every row has label+value', panel.rows.every((row) => typeof row.label === 'string' && row.label.length > 0 && typeof row.value === 'string' && row.value.length > 0))
check('fingerprint on its own row', panel.rows.some((row) => row.label === 'system_fingerprint' && row.value === value.systemFingerprint))
check('plaintext on its own row', panel.rows.some((row) => row.label === '检查点明文' && row.value === value.checkpoint.plaintext))
check('checkpoint row', panel.rows.some((row) => row.label === '检查点' && row.value === 'flash 1017'))
check('endpoint rows separate', labels.includes('探测端点') && labels.includes('对话端点'))
check('confidence row', panel.rows.some((row) => row.label === '同层可信度' && row.value.startsWith('高')))
check('correlate row', panel.rows.some((row) => row.label === '最近对话响应' && row.value.includes('相差')))
check('capture row shows evidence-only by default', panel.rows.some((row) => row.label === '响应存证' && row.value.includes('已拦截 72 份响应元数据')))
check('no mega row (single value not holding whole dump)', panel.rows.every((row) => row.value.length <= 120))
check('notes multi-line', panel.notes.length >= 3, String(panel.notes.length))
check('footer hint', panel.footer.length > 0)

// 未知指纹：显示 md5 且有“未收录”说明
const unknownPanel = lib.buildPanelContent(t, {
  kind: 'value',
  value: {
    ...value,
    systemFingerprint: '0123456789abcdef0123456789abcdef',
    display: '0123456789abcdef0123456789abcdef',
    displayKind: 'fingerprint',
    checkpoint: null,
    confidence: 'low',
    confidenceNote: '尚未拦截到本会话的真实请求，探测端点来自配置',
  },
})
check('unknown md5 row', unknownPanel.rows.some((row) => row.label === '检查点' && row.value === '映射表未收录'))
check('unknown md5 own row', unknownPanel.rows.some((row) => row.label === 'system_fingerprint' && row.value === '0123456789abcdef0123456789abcdef'))
check('unknown table miss note', unknownPanel.notes.includes('映射表未收录该指纹，显示原始 md5。'))

// 稳定性未校验时要有解释说明
const singlePanel = lib.buildPanelContent(t, { kind: 'value', value: { ...value, stable: null } })
check('stability single note', singlePanel.notes.some((note) => note.includes('稳定性未校验')), JSON.stringify(singlePanel.notes))
check('stability single row', singlePanel.rows.some((row) => row.label === '稳定性' && row.value === '单次，未校验'))

// 刷新反馈：footer 三态
check('footer idle', panel.footer === '点击强制重新探测', panel.footer)
check('footer refreshing', lib.buildPanelContent(t, { kind: 'value', value, refreshing: true }).footer === '正在重新探测…')
check('footer done', lib.buildPanelContent(t, { kind: 'value', value, justRefreshed: true }).footer === '刚刚已重新探测')

// ── 2b) 存证隐私三态：原始字节开 / 关 / 拦截总开关关 ────────────────────
const captureRowOf = (capture) => {
  const content = lib.buildPanelContent(t, { kind: 'value', value: { ...value, capture } })
  return content.rows.find((row) => row.label === '响应存证')
}
const rawOn = captureRowOf({ enabled: true, rawEnabled: true, total: 72, last: { at: 1792219759000, kind: 'messages', truncated: false } })
check('capture raw-on shows saved files', rawOn !== undefined && rawOn.value.includes('已保存 72 份'))
const rawOffEmpty = captureRowOf({ enabled: true, rawEnabled: false, total: 0, last: null })
check('capture raw-off with no evidence says bodies are not persisted', rawOffEmpty !== undefined && rawOffEmpty.value.includes('不落盘'))
const rawOffSome = captureRowOf({ enabled: true, rawEnabled: false, total: 3, last: { at: 1792219759000, kind: 'chat', truncated: false } })
check('capture raw-off with evidence counts metadata', rawOffSome !== undefined && rawOffSome.value.includes('已拦截 3 份响应元数据'))
const captureOff = captureRowOf({ enabled: false, rawEnabled: false, total: 0, last: null })
check('capture master off says interception disabled', captureOff !== undefined && captureOff.value.includes('capture: false'))
check('capture privacy notes exist in both dictionaries', typeof zh['note.captureRawOff'] === 'string' && typeof en['note.captureRawOff'] === 'string')

// ── 2c) 可选外部告警：合并进指纹展示（display-only） ───────────────────
const alertWarn = {
  version: 1,
  level: 'warn',
  verdict: 'gray-candidate',
  message: '指纹未变但行为通道偏移（G）：疑似灰度',
  updatedAt: 1792435200000,
  subject: { provider: 'deepseek-official', model: 'deepseek-flash', checkpoint: { name: 'flash 1017', fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' } },
  signals: [
    { channel: 'G', verdict: 'changed', detail: '失败率偏移 20.0 个百分点' },
    { channel: 'T', verdict: 'unchanged', detail: 'T 向量与模板一致' },
  ],
  caveats: ['疑似结论需要连续复现'],
}
const warnedPanel = lib.buildPanelContent(t, { kind: 'value', value, alert: alertWarn })
check('alert merged into fingerprint panel', warnedPanel.rows.some((row) => row.label === '行为告警' && row.value.includes('疑似灰度')))
check('alert changed channel row', warnedPanel.rows.some((row) => row.label.includes('告警通道') && row.label.includes('G')))
check('alert notes include external disclaimer', warnedPanel.notes.some((note) => note.includes('外部只读文件')))
check('alert caveats appended', warnedPanel.notes.some((note) => note.includes('连续复现')))
const warnedBadge = lib.badgeOf(t, { kind: 'value', value, alert: alertWarn })
check('alert warn badge keeps text and appends marker', warnedBadge.text === 'flash 1017 ⚠' && warnedBadge.tone === 'unknown')
const criticalBadge = lib.badgeOf(t, { kind: 'value', value, alert: { ...alertWarn, level: 'critical' } })
check('alert critical badge uses error tone', criticalBadge.text === 'flash 1017 ⚠' && criticalBadge.tone === 'error')
check('alert ok does not add marker', lib.badgeOf(t, { kind: 'value', value, alert: { ...alertWarn, level: 'ok' } }).text === 'flash 1017')
check('panel without alert unchanged', lib.buildPanelContent(t, { kind: 'value', value }).rows.every((row) => row.label !== '行为告警'))

// ── 3) 英文词典同样完整 ────────────────────────────────────────────────
const tEn = (key) => (en[key] !== undefined ? en[key] : key)
const panelEn = lib.buildPanelContent(tEn, { kind: 'value', value })
check('en panel rows', panelEn.rows.length === panel.rows.length)
check('en no raw key leaks', panelEn.rows.every((row) => !row.label.startsWith('label.')) && panelEn.notes.every((note) => !note.startsWith('note.')))

// ── 4) 悬浮卡片定位：下方空间足够在下方，不够翻到上方 ──────────────────
const below = lib.panelPlacement({ top: 100, bottom: 124, right: 1200 })
check('placement below', typeof below.top === 'number' && below.bottom === undefined)
const above = lib.panelPlacement({ top: 820, bottom: 844, right: 1200 })
check('placement above when no room', typeof above.bottom === 'number' && above.top === undefined)
check('placement width bounded', below.width <= 340 && below.right >= 8)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
