// dsh-system-fingerprint — 宿主半边。
//
// 目标：让会话头部挂一个「当前后端检查点」徽标。数据来自两条路：
//
//   1) 主动探测（主路）：用 DSH credentials 里的 DEEPSEEK_API_KEY 请求 OpenAI 兼容端点
//      POST <openaiBaseURL>/chat/completions，读响应体 system_fingerprint（32 位小写 hex），
//      再用内置的 MD5 明文映射表翻译成检查点名。对话实际走的 Anthropic Messages 端点
//      （/anthropic/messages）不返回该字段，所以不能从会话事件里读，只能探测。
//
//   2) 原始响应拦截（存证 + 兜底）：在宿主进程里给 globalThis.fetch 套一层只读包装，
//      对所有命中「模型补全端点」的 /messages、/chat/completions 响应做 response.clone()，
//      在 DSH 适配器解码之前解析响应头/正文里的 model、system_fingerprint、网关溯源头、
//      trace id、会话 id 等元数据。**默认只留元数据**：把解码前原始字节落盘是可选项
//      （`captureRaw: true`，默认关——原始响应体包含模型正文，分发版隐私优先）。
//      这样即使将来字段位置变化、或会话日志只留下归一化事件，「原始数据解码前的内容」也还在，
//      而默认安装不会在磁盘上留下任何模型回复正文。
//      注意：Messages 端点当前确实不含 system_fingerprint（2026-10-17 实测），
//      拦截层保存的是原始字节证据；徽标显示的指纹仍来自（1）的主动探测。
//      网关溯源响应头默认取 OpenCode Go / Zen 那组，可用 `gatewayHeaders` 换成别的网关。
//
// 路由：connection.fetch 注册 /api/system-fingerprint/state（GET），复用 /api 围栏的
// Host/Origin 校验与浏览器 cookie 鉴权，返回纯 JSON；HTTP 一律 200，客户端只看 body.ok。
//
// 约束：
//   * 不在日志/UI 里打印 API key；请求头只读不落盘，Authorization 永不入档。
//   * 请求体只解析出「model」一个字段用于归属，不保存 prompt 内容。
//   * 所有资源（fetch 补丁、路由、llm/stream 监听、定时器）都登记在插件 effect 上，卸载即还原。
//
// 本模块只 import Node 内建模块（工作区插件不经过 dsh 安装目录解析 @deepseek-ai/*）。

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-system-fingerprint'

/** 硬依赖 connection（/api 路由围栏）；sessions/sessionProjections/agentDefaultModel 均按需软取。 */
export const inject = ['connection']

const STATE_PATH = '/api/system-fingerprint/state'
/** 对外 HTTP 状态接口的契约版本（只加字段；删改字段必须 bump）。见 docs/INTERFACE.md。 */
const API_VERSION = 1
/** 只读配置文件（config.json）的契约版本。 */
const CONFIG_EXPORT_VERSION = 1
/** 外部告警文件（可选输入，display-only）的契约版本。 */
const ALERT_SCHEMA_VERSION = 1
/** 外部告警文件读取缓存（毫秒）：文件小、刷新 10 分钟一次，15s 足够。 */
const ALERT_CACHE_TTL_MS = 15 * 1000
/** 包版本：与 package.json 保持一致（分发测试断言两者相同）。 */
const PLUGIN_VERSION = '0.3.0'
const STORAGE_SUBDIR = 'storages/system-fingerprint'
const CONFIG_EXPORT_FILE = 'config.json'
const RAW_SUBDIR = 'raw'
const PROBE_HELLO = 'hi'
const MAX_META_ENTRIES = 40
const MAX_SESSION_RECORDS = 60
const PERSIST_DELAY_MS = 1500
const PRUNE_INTERVAL_MS = 5000

/** 内置检查点映射表（来自 SYSTEM_FINGERPRINT_PROBE.md，2026-10-17 实测 4/4 通过）。
 * plaintext 与 fingerprint 至少给一个：只给 plaintext 时启动时算 md5。 */
const DEFAULT_CHECKPOINTS = [
  { name: 'v4-pro', plaintext: 'fp_v4pro_20260812_prod0820_fp8_kvcache_20260402_fp', fingerprint: 'a307abda487cd1b463329ccb945ce396' },
  { name: 'v4f 0908（内测）', plaintext: 'fp_v41f_0908_prod0820_fp8_kvcache_20260402_fp', fingerprint: '6d641ab04c479a91a8f79fb96f1d69c0' },
  { name: 'flash 0910（统一版）', plaintext: 'fp_dsv41f_0910_prod0820_fp8_kvcache_20260402_fp', fingerprint: 'aeb56401ca74e127821c4f9126dcb669' },
  { name: 'flash 1017', plaintext: 'fp_dsv41f_1017_prod0820_fp8_kvcache_20260402_fp', fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' },
]

/**
 * 网关溯源头：上游（OpenCode Go / Zen 等）不返回 `system_fingerprint` 时，唯一可得的
 * 请求级证据。语义要说清楚——它标识「这次请求落到了哪个后端池/哪条上游路由」，
 * **不是**模型版本指纹，而且会随负载均衡逐请求变化。
 *
 * 这里只是**默认值**：配置 `gatewayHeaders` 可以按语义角色换成别的网关的响应头
 * （例如把 endpointId 映射到 `x-upstream-provider`、logId 映射到 `x-request-id`），
 * 也可以写 `false` 整体关闭网关溯源。角色之外的自定义键名会作为附加行展示。
 */
const DEFAULT_GATEWAY_HEADERS = {
  endpointId: 'x-opencode-endpoint-id',
  upstreamModelId: 'x-opencode-upstream-model-id',
  logId: 'x-opencode-log-id',
  zenModel: 'x-zen-model',
  placement: 'cf-placement',
  rayId: 'cf-ray',
}

/** 网关路由自己的会话头默认值：harness 会话头缺席时用它把响应关联回会话（取值就是同一个会话 id）。 */
const DEFAULT_GATEWAY_SESSION_HEADER = 'x-opencode-session'

/**
 * 默认也拦截这些网关 host。网关路由（pi-ai 适配器）既不带 `x-deepseek-harness-*` 头，
 * 也不在 `openaiBaseURL` 推导范围内，不列进来就一份都抓不到。
 */
const DEFAULT_GATEWAY_HOSTS = ['opencode.ai']

/** 会话关联完全缺失时，按 model 兜底匹配网关存证的时间窗。 */
const GATEWAY_MATCH_TTL_MS = 15 * 60 * 1000

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** @param {Date} date */
function stamp (date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
}

function md5Hex (value) {
  return createHash('md5').update(String(value), 'utf8').digest('hex')
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringOr (value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function positiveInt (value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const floored = Math.trunc(number)
  if (floored < min) return min
  if (floored > max) return max
  return floored
}

function messageOf (error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isTimeoutError (error) {
  return Boolean(error && (
    (error.name === 'TimeoutError') ||
    (error.name === 'AbortError') ||
    /timeout|timed out/i.test(messageOf(error))
  ))
}

/** @param {unknown} value */
function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 插件自己的错误类型：带稳定的 code，客户端据此给本地化文案。 */
class FingerprintError extends Error {
  constructor (code, message, extra) {
    super(message)
    this.name = 'FingerprintError'
    this.code = code
    this.extra = extra ?? {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

/** 从 DEEPSEEK_BASE_URL / 默认值推导探测端点根（去掉 /anthropic 后缀）。 */
function defaultOpenAIBaseURL (env = process.env) {
  const configured = typeof env.DEEPSEEK_BASE_URL === 'string' ? env.DEEPSEEK_BASE_URL.trim() : ''
  if (configured.length > 0) {
    try {
      const url = new URL(configured)
      url.pathname = url.pathname.replace(/\/anthropic\/?$/u, '')
      const path = url.pathname.replace(/\/+$/u, '')
      return `${url.origin}${path === '/' ? '' : path}`
    } catch {
      // 非法值退回官方默认
    }
  }
  return 'https://api.deepseek.com'
}

function trimBaseURL (value) {
  const text = String(value).trim()
  return text.replace(/\/+$/u, '')
}

/**
 * 从一条真实的对话请求 URL 反推同一层的「OpenAI 兼容端点根」。
 *
 * DeepSeek 适配器实际请求 `${baseURL(+/v1)}/messages`，官方 base 是
 * `https://api.deepseek.com/anthropic`，所以线上真实路径是 `/anthropic/v1/messages`。
 * 反推时依次去掉 `/messages`、末尾 `/v1`、末尾 `/anthropic`，剩下 origin + 前缀，
 * 探测就发到同一 origin/前缀下的 `/chat/completions`——如果对话被自己的网关转发，
 * 探测也会走同一个网关入口，而不是绕开它直连官方。
 *
 * 例：
 *   https://api.deepseek.com/anthropic/v1/messages   → https://api.deepseek.com
 *   https://gw.example.com/ds/anthropic/v1/messages  → https://gw.example.com/ds
 *   https://gw.example.com/v1/messages               → https://gw.example.com
 */
function deriveConversationBase (urlText) {
  let url
  try {
    url = new URL(String(urlText))
  } catch {
    return undefined
  }
  let pathname = url.pathname.replace(/\/+$/u, '')
  // 先去掉补全端点后缀（Anthropic / OpenAI 两种形态都认识）。
  for (const suffix of ['/chat/completions', '/completions', '/messages']) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length)
      break
    }
  }
  // 再去掉协议层前缀：/anthropic、末尾 /v1（顺序可能交错，循环到稳定）。
  for (let changed = true; changed;) {
    changed = false
    if (pathname.endsWith('/anthropic')) {
      pathname = pathname.slice(0, -'/anthropic'.length)
      changed = true
    }
    if (pathname.endsWith('/v1')) {
      pathname = pathname.slice(0, -'/v1'.length)
      changed = true
    }
  }
  const base = `${url.origin}${pathname === '/' ? '' : pathname}`.replace(/\/+$/u, '')
  return base.length > 0 ? base : url.origin
}

function hostOf (urlText) {
  try {
    return new URL(urlText).host.toLowerCase()
  } catch {
    return undefined
  }
}

function normalizeHosts (input, openaiBaseURL, gatewayHosts = new Set(DEFAULT_GATEWAY_HOSTS)) {
  const hosts = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const text = value.trim().toLowerCase()
    if (text.length === 0) return
    // 允许直接写 host（api.deepseek.com）或 URL（https://api.deepseek.com）
    if (text.includes('://')) {
      const host = hostOf(text)
      if (host) hosts.add(host)
      return
    }
    hosts.add(text.replace(/\/.*$/u, ''))
  }
  if (Array.isArray(input)) input.forEach(push)
  else if (input !== undefined && input !== null) push(input)
  if (hosts.size === 0) {
    // 默认拦截：探测根 + 环境覆盖的对话根 + 网关 host。
    const fromBase = hostOf(openaiBaseURL)
    if (fromBase) hosts.add(fromBase)
    const fromEnv = process.env.DEEPSEEK_BASE_URL ? hostOf(process.env.DEEPSEEK_BASE_URL) : undefined
    if (fromEnv) hosts.add(fromEnv)
    if (hosts.size === 0) hosts.add('api.deepseek.com')
  }
  // 网关 host 无条件并入：显式写 captureHosts 时漏掉它，也不会让网关存证静默失效。
  for (const host of gatewayHosts) hosts.add(host)
  return hosts
}

/** 解析 gatewayHosts：默认 opencode.ai，可被 profile 覆盖。 */
function normalizeGatewayHosts (input) {
  const hosts = new Set(DEFAULT_GATEWAY_HOSTS)
  const list = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input]
  for (const value of list) {
    if (typeof value !== 'string') continue
    const text = value.trim().toLowerCase()
    if (text.length === 0) continue
    const host = text.includes('://') ? hostOf(text) : text.replace(/\/.*$/u, '')
    if (host) hosts.add(host)
  }
  return hosts
}

/**
 * 解析网关响应头映射（供应商无关）。
 *
 * 输入形态（都可用 profile patch 覆盖）：
 *   * `undefined` → 默认 OpenCode Go / Zen 那组头；
 *   * 对象 → 按语义角色部分覆盖，例如 `{ endpointId: 'x-upstream-provider' }`；
 *     某个角色的值写 `false` / `null` / 空串表示「该角色不用」；
 *     对象里角色之外的键名会作为**附加溯源字段**（键名即展示名）保留；
 *   * `false` → 整体关闭网关溯源（不解析任何溯源头，也不再把端点折进登记表）。
 *
 * @returns {{ enabled: boolean, fields: Array<{ key: string, header: string }> }}
 */
function normalizeGatewayHeaders (input) {
  if (input === false) return { enabled: false, fields: [] }
  const overrides = isObject(input) ? input : {}
  const fields = []
  const seenHeaders = new Set()
  const push = (key, headerValue) => {
    if (typeof headerValue !== 'string') return
    const header = headerValue.trim().toLowerCase()
    if (header.length === 0 || header.length > 64) return
    if (seenHeaders.has(header)) return
    seenHeaders.add(header)
    fields.push({ key, header })
  }
  for (const [key, fallback] of Object.entries(DEFAULT_GATEWAY_HEADERS)) {
    if (!Object.hasOwn(overrides, key)) {
      push(key, fallback)
      continue
    }
    const override = overrides[key]
    // false / null / ''：显式去掉这个角色
    if (override === false || override === null || override === '') continue
    push(key, typeof override === 'string' ? override : fallback)
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(DEFAULT_GATEWAY_HEADERS, key)) continue
    if (key.trim().length === 0 || key.trim().length > 64) continue
    if (value === false || value === null || value === '') continue
    push(key, typeof value === 'string' ? value : undefined)
  }
  return { enabled: fields.length > 0, fields }
}

/** 解析网关会话头；`false` / `null` 表示不做网关侧会话关联。 */
function normalizeGatewaySessionHeader (input) {
  if (input === false || input === null) return null
  if (typeof input !== 'string' || input.trim().length === 0) return DEFAULT_GATEWAY_SESSION_HEADER
  return input.trim().toLowerCase()
}

function normalizeTable (input) {
  const rows = Array.isArray(input) && input.length > 0 ? input : DEFAULT_CHECKPOINTS
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (!isObject(row)) continue
    const plaintext = typeof row.plaintext === 'string' && row.plaintext.length > 0 ? row.plaintext : undefined
    const name = stringOr(row.name, '')
    let fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint.trim().toLowerCase() : ''
    if (!fingerprint && plaintext !== undefined) fingerprint = md5Hex(plaintext)
    if (!/^[0-9a-f]{32}$/u.test(fingerprint)) continue
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ name: name || fingerprint, plaintext: plaintext ?? null, fingerprint })
  }
  if (out.length === 0) return normalizeTable(DEFAULT_CHECKPOINTS)
  return out
}

/**
 * 归一化插件配置。所有值都可被 profile patch 覆盖；缺省值与文档建议一致。
 * @param {unknown} raw
 * @returns {object}
 */
function normalizeConfig (raw) {
  const input = isObject(raw) ? raw : {}
  const openaiBaseURL = trimBaseURL(stringOr(input.openaiBaseURL, defaultOpenAIBaseURL()))
  const checkpoints = normalizeTable(input.checkpointTable)
  const gatewayHosts = normalizeGatewayHosts(input.gatewayHosts)
  return {
    provider: stringOr(input.provider, 'deepseek-official'),
    model: stringOr(input.model, 'deepseek-flash'),
    openaiBaseURL,
    apiKeyEnv: stringOr(input.apiKeyEnv, 'DEEPSEEK_API_KEY'),
    timeoutMs: positiveInt(input.timeoutMs, 15000, 1000, 60000),
    cacheTtlMs: positiveInt(input.cacheTtlMs, 60000, 1000, 6 * 3600 * 1000),
    errorTtlMs: positiveInt(input.errorTtlMs, 10000, 0, 10 * 60 * 1000),
    stabilityChecks: positiveInt(input.stabilityChecks, 1, 1, 5),
    /**
     * `capture` 是「响应拦截」总开关：拦截响应头/元数据，供徽标网关溯源与端点登记表使用；
     * 拦截不落原始字节（见下面的 captureRaw），所以默认开。
     */
    capture: input.capture !== false,
    /**
     * `captureRaw` 是「把解码前原始字节写到磁盘」的开关。分发版**默认关**（隐私优先：
     * 原始响应体包含模型正文）；需要存证的部署显式写 captureRaw: true。
     */
    captureRaw: input.captureRaw === true,
    /** 是否连请求头/响应头原文一起存证（凭据字段始终脱敏）。 */
    captureHeaders: input.captureHeaders !== false,
    captureHosts: normalizeHosts(input.captureHosts, openaiBaseURL, gatewayHosts),
    gatewayHosts,
    /** 网关溯源头映射（供应商无关）：默认 OpenCode 那组，可整体/按角色替换或关闭。 */
    gatewayHeaders: normalizeGatewayHeaders(input.gatewayHeaders),
    /** 网关会话头：harness 会话头缺席时用它把响应关联回会话；false = 不关联。 */
    gatewaySessionHeader: normalizeGatewaySessionHeader(input.gatewaySessionHeader),
    /**
     * 可选：外部告警文件（通用 JSON schema v1，display-only）。插件只读它并把告警合并进徽标展示；
     * 文件缺失/损坏/版本不认识都静默降级——插件不依赖任何产出方。
     */
    externalAlertFile: (() => {
      const raw = input.externalAlertFile
      if (typeof raw !== 'string' || raw.trim().length === 0) return null
      return raw.trim()
    })(),
    maxRawBytes: positiveInt(input.maxRawBytes, 512 * 1024, 4096, 8 * 1024 * 1024),
    maxRawFiles: positiveInt(input.maxRawFiles, 120, 0, 2000),
    checkpoints,
    tableByFingerprint: new Map(checkpoints.map((entry) => [entry.fingerprint, entry])),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 路径 / 状态
// ─────────────────────────────────────────────────────────────────────────────

function resolveDshHome () {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

function storagePaths () {
  const root = join(resolveDshHome(), STORAGE_SUBDIR)
  return {
    root,
    raw: join(root, RAW_SUBDIR),
    meta: join(root, 'meta.json'),
    /** 路由端点登记表：持续累积「网关到底有哪些上游端点」，跨重启保留。 */
    endpoints: join(root, 'endpoints.json'),
    /** 只读配置导出（provider / 开关 / 网关映射；无凭据）。契约见 docs/INTERFACE.md。 */
    config: join(root, CONFIG_EXPORT_FILE),
    /** 相对 $DSH_HOME 的展示路径（不把绝对 home 塞进 UI）。 */
    displayRoot: STORAGE_SUBDIR,
  }
}

function createEnv (ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  return {
    ctx,
    config,
    paths: storagePaths(),
    entries: [],
    lastBySession: new Map(),
    lastCallBySession: new Map(),
    /** 每会话最近一次真实对话请求的同源端点信息（内存态；重启后由 meta entries 回填）。 */
    lastRequestBySession: new Map(),
    lastStreamCall: null,
    lastProbe: null,
    captureCount: 0,
    /** 路由端点登记表（跨重启累积；见 emptyEndpointRegistry 的字段说明）。 */
    endpoints: emptyEndpointRegistry(),
    probeCache: new Map(),
    probeInflight: new Map(),
    /** 外部告警文件读取缓存（mtime/时间窗）。 */
    alertCache: undefined,
    persistTimer: undefined,
    lastPersistAt: 0,
    lastPruneAt: 0,
    pruning: false,
  }
}

function rememberBounded (map, key, value, max) {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** 把元数据落盘（防抖）。失败不影响主流程。 */
function schedulePersist (env) {
  if (env.persistTimer !== undefined) return
  const wait = Math.max(0, PERSIST_DELAY_MS - (env.lastPersistAt === undefined ? 0 : Date.now() - env.lastPersistAt))
  env.persistTimer = setTimeout(() => {
    env.persistTimer = undefined
    env.lastPersistAt = Date.now()
    void persistMeta(env)
    void persistEndpoints(env)
  }, wait)
  if (typeof env.persistTimer.unref === 'function') env.persistTimer.unref()
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由端点登记表（持续累积「网关到底有哪些上游端点」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 空登记表：按 endpointId 索引，字段刻意留宽——脚本与人工都能继续加字段而不用改版本。
 *
 *   {
 *     version, updatedAt,
 *     endpoints: {
 *       "<endpointId>": {
 *         endpointId, firstSeenAt, lastSeenAt, count,
 *         sources: { capture, probe },                  // 证据来源计数
 *         models: { "<modelId>": { count, firstSeenAt, lastSeenAt,
 *                                  upstreamModelIds: { "<上游串>": count },
 *                                  idFamilies: { "<id 形态>": count }, contexts: {...} } },
 *         lastContext: { sessionId, logId, rayId, placement, upstreamModelId, idFamily, status }
 *       }
 *     }
 *   }
 */
function emptyEndpointRegistry () {
  return { version: 1, updatedAt: 0, endpoints: {} }
}

/** 响应 id 的形态：由后端是否透传原生 id 决定，是端点的一个可观测特征。 */
function responseIdFamily (id) {
  if (typeof id !== 'string' || id.length === 0) return 'unknown'
  if (id.startsWith('gw-')) return 'gateway'
  if (/^chatcmpl-/u.test(id)) return 'chatcmpl'
  if (/^[0-9a-f]{32,}$/u.test(id)) return 'hex-native'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/u.test(id)) return 'uuid'
  return 'other'
}

function bumpCount (bag, key) {
  if (typeof key !== 'string' || key.length === 0) return
  bag[key] = (bag[key] ?? 0) + 1
}

/**
 * 把一份带网关溯源的存证折进登记表。纯内存操作，调用方随后触发防抖落盘。
 * 任何字段缺失都只跳过该项，不抛错——它跑在真实请求的旁路上。
 */
function accumulateEndpoint (env, meta) {
  try {
    const gateway = isObject(meta) && isObject(meta.gateway) ? meta.gateway : null
    if (gateway === null) return false
    const firstField = Array.isArray(gateway.fields) && gateway.fields.length > 0 ? gateway.fields[0] : null
    const endpointId = typeof gateway.endpointId === 'string' && gateway.endpointId.length > 0
      ? gateway.endpointId
      // 自定义映射可能没有 endpointId 角色：用配置里的第一个溯源字段当端点标识，保证登记表不断。
      : typeof firstField?.value === 'string' && firstField.value.length > 0
        ? firstField.value
        : '(未命名端点)'
    if (!isObject(env.endpoints)) env.endpoints = emptyEndpointRegistry()
    const registry = env.endpoints
    if (!isObject(registry.endpoints)) registry.endpoints = {}
    const at = Number.isFinite(meta.at) ? meta.at : Date.now()
    const model = typeof meta.responseModel === 'string' && meta.responseModel.length > 0
      ? meta.responseModel
      : (typeof meta.requestModel === 'string' && meta.requestModel.length > 0 ? meta.requestModel : '(未知模型)')
    const source = meta.probe === true || meta.purpose === 'probe' ? 'probe' : 'capture'
    const idFamily = responseIdFamily(meta.responseId)

    const entry = isObject(registry.endpoints[endpointId]) ? registry.endpoints[endpointId] : {
      endpointId,
      firstSeenAt: at,
      lastSeenAt: at,
      count: 0,
      sources: {},
      models: {},
    }
    entry.firstSeenAt = Math.min(Number.isFinite(entry.firstSeenAt) ? entry.firstSeenAt : at, at)
    entry.lastSeenAt = Math.max(Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : at, at)
    entry.count = (entry.count ?? 0) + 1
    if (!isObject(entry.sources)) entry.sources = {}
    entry.sources[source] = (entry.sources[source] ?? 0) + 1
    if (!isObject(entry.models)) entry.models = {}
    const modelEntry = isObject(entry.models[model]) ? entry.models[model] : {
      count: 0,
      firstSeenAt: at,
      lastSeenAt: at,
      upstreamModelIds: {},
      idFamilies: {},
      contexts: {},
    }
    modelEntry.count = (modelEntry.count ?? 0) + 1
    modelEntry.firstSeenAt = Math.min(Number.isFinite(modelEntry.firstSeenAt) ? modelEntry.firstSeenAt : at, at)
    modelEntry.lastSeenAt = Math.max(Number.isFinite(modelEntry.lastSeenAt) ? modelEntry.lastSeenAt : at, at)
    if (!isObject(modelEntry.upstreamModelIds)) modelEntry.upstreamModelIds = {}
    if (!isObject(modelEntry.idFamilies)) modelEntry.idFamilies = {}
    if (!isObject(modelEntry.contexts)) modelEntry.contexts = {}
    bumpCount(modelEntry.upstreamModelIds, gateway.upstreamModelId)
    bumpCount(modelEntry.idFamilies, idFamily)
    bumpCount(modelEntry.contexts, typeof meta.conversationBase === 'string' ? meta.conversationBase : undefined)
    entry.models[model] = modelEntry
    entry.lastContext = {
      at,
      sessionId: meta.sessionId ?? null,
      sessionIdSource: meta.sessionIdSource ?? null,
      requestModel: meta.requestModel ?? null,
      responseModel: meta.responseModel ?? null,
      upstreamModelId: gateway.upstreamModelId ?? null,
      zenModel: gateway.zenModel ?? null,
      logId: gateway.logId ?? null,
      rayId: gateway.rayId ?? null,
      placement: gateway.placement ?? null,
      /** 完整溯源字段（含自定义 gatewayHeaders 角色），按配置顺序保存。 */
      fields: Array.isArray(gateway.fields)
        ? gateway.fields.map((field) => ({ key: field.key, value: field.value }))
        : [],
      idFamily,
      status: Number.isFinite(meta.status) ? meta.status : null,
      source,
    }
    registry.endpoints[endpointId] = entry
    registry.updatedAt = Date.now()
    return true
  } catch {
    return false
  }
}

/** 登记表落盘（原子替换）。失败不影响主流程。 */
async function persistEndpoints (env) {
  try {
    if (!isObject(env.endpoints)) return
    const live = env.endpoints
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      note: '由 dsh-system-fingerprint 持续累积：每次真实模型响应 / 探测响应里配置的网关溯源响应头（默认 x-opencode-*）都会折进来。人工标注请放到独立文件，勿直接改这里。',
      endpoints: live.endpoints ?? {},
    }
    await mkdir(env.paths.root, { recursive: true })
    const temporary = `${env.paths.endpoints}.tmp`
    await writeFile(temporary, JSON.stringify(payload, null, 2))
    await rename(temporary, env.paths.endpoints)
  } catch {
    // 目录不可写时保持内存态
  }
}

/** 启动时读回登记表，让累积跨重启继续。 */
async function hydrateEndpoints (env) {
  try {
    const payload = JSON.parse(await readFile(env.paths.endpoints, 'utf8'))
    if (!isObject(payload) || !isObject(payload.endpoints)) return
    env.endpoints = { version: 1, updatedAt: Number.isFinite(payload.updatedAt) ? payload.updatedAt : 0, endpoints: payload.endpoints }
  } catch {
    env.endpoints = emptyEndpointRegistry()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 只读配置导出（对外契约 config.json v1，见 docs/INTERFACE.md）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 组装只读配置快照。**白名单字段**：只放路由/开关/映射，绝不放凭据值
 * （apiKeyEnv 只是环境变量或凭据 ref 的名字）。
 * @param {object} env
 */
function configExportOf (env) {
  const config = env.config
  const lastProbe = isObject(env.lastProbe) ? env.lastProbe : null
  let checkpoint = null
  if (lastProbe !== null && typeof lastProbe.systemFingerprint === 'string' && lastProbe.systemFingerprint.length > 0) {
    const entry = mapFingerprint(config, lastProbe.systemFingerprint)
    checkpoint = {
      fingerprint: lastProbe.systemFingerprint,
      name: entry === null ? null : entry.name,
      source: 'probe',
      provider: lastProbe.provider ?? null,
      model: lastProbe.model ?? null,
      probedAt: Number.isFinite(lastProbe.at) ? lastProbe.at : null,
      endpointHost: lastProbe.endpointHost ?? null,
      confidence: lastProbe.confidence ?? null,
    }
  }
  return {
    version: CONFIG_EXPORT_VERSION,
    updatedAt: Date.now(),
    note: '由 dsh-system-fingerprint 只读导出：不含凭据；字段只增不减。契约见 docs/INTERFACE.md',
    plugin: { name: 'dsh-system-fingerprint', version: PLUGIN_VERSION, stateApiVersion: API_VERSION },
    probe: {
      provider: config.provider,
      model: config.model,
      openaiBaseURL: config.openaiBaseURL,
      /** 凭据 ref / 环境变量名，不是凭据值。 */
      apiKeyEnv: config.apiKeyEnv,
      timeoutMs: config.timeoutMs,
      cacheTtlMs: config.cacheTtlMs,
      stabilityChecks: config.stabilityChecks,
    },
    capture: {
      enabled: config.capture,
      rawEnabled: config.captureRaw,
      headersEnabled: config.captureHeaders,
      hosts: [...config.captureHosts],
    },
    gateway: {
      enabled: config.gatewayHeaders.enabled,
      hosts: [...config.gatewayHosts],
      sessionHeader: config.gatewaySessionHeader,
      headers: config.gatewayHeaders.fields.map(({ key, header }) => ({ key, header })),
    },
    /** 可选外部告警输入是否配置（不导出路径，避免把本机目录写进契约文件）。 */
    alerts: { enabled: config.externalAlertFile !== null },
    /** 检查点映射表：只导 name + fingerprint（明文不属于对外契约）。 */
    checkpoints: config.checkpoints.map(({ name, fingerprint }) => ({ name, fingerprint })),
    /** 最近一次成功探测到的检查点；外部采集器可用它把「行为模板」绑定到已知指纹上。 */
    checkpoint,
  }
}

/** 原子写 config.json（失败不影响主流程）。 */
async function persistConfigExport (env) {
  try {
    await mkdir(env.paths.root, { recursive: true })
    const temporary = `${env.paths.config}.tmp`
    await writeFile(temporary, JSON.stringify(configExportOf(env), null, 2))
    await rename(temporary, env.paths.config)
  } catch {
    // 存证目录不可写时保持内存态
  }
}

async function persistMeta (env) {
  try {
    await mkdir(env.paths.root, { recursive: true })
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      captureCount: env.captureCount,
      entries: env.entries.slice(0, MAX_META_ENTRIES),
      lastBySession: Object.fromEntries([...env.lastBySession].slice(-MAX_SESSION_RECORDS)),
      lastStreamCall: env.lastStreamCall ?? null,
      lastProbe: env.lastProbe ?? null,
    }
    const temporary = `${env.paths.meta}.tmp`
    await writeFile(temporary, JSON.stringify(payload, null, 2))
    await rename(temporary, env.paths.meta)
  } catch {
    // 存证目录不可写时保持内存态即可
  }
}

async function hydrateMeta (env) {
  try {
    const payload = JSON.parse(await readFile(env.paths.meta, 'utf8'))
    if (!isObject(payload)) return
    if (Array.isArray(payload.entries)) {
      env.entries = payload.entries.filter(isObject).slice(0, MAX_META_ENTRIES)
    }
    if (isObject(payload.lastBySession)) {
      for (const [key, value] of Object.entries(payload.lastBySession)) {
        if (isObject(value)) env.lastBySession.set(key, value)
      }
    }
    // entries 是新→旧排列：每个会话取最新一条带 conversationBase 的真实请求，回填端点记忆。
    for (const entry of env.entries) {
      if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) continue
      if (typeof entry.conversationBase !== 'string' || entry.conversationBase.length === 0) continue
      if (env.lastRequestBySession.has(entry.sessionId)) continue
      env.lastRequestBySession.set(entry.sessionId, {
        at: entry.at,
        requestUrl: entry.requestUrl ?? null,
        conversationBase: entry.conversationBase,
        requestModel: entry.requestModel ?? null,
      })
    }
    if (isObject(payload.lastStreamCall)) env.lastStreamCall = payload.lastStreamCall
    if (isObject(payload.lastProbe)) env.lastProbe = payload.lastProbe
    if (Number.isFinite(payload.captureCount)) env.captureCount = payload.captureCount
  } catch {
    // 首次运行没有 meta.json
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 原始响应拦截（解码前保存）
// ─────────────────────────────────────────────────────────────────────────────

/** 只关心模型补全端点；余额、模型列表等其它 API 一律放过。 */
function classifyApiPath (pathname) {
  if (typeof pathname !== 'string') return null
  if (/\/chat\/completions$/u.test(pathname)) return 'chat'
  if (/\/messages$/u.test(pathname)) return 'messages'
  if (/\/(?:completions)$/u.test(pathname)) return 'completions'
  return null
}

function requestURLOf (input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (isObject(input) && typeof input.url === 'string') return input.url
  return ''
}

function headerFrom (input, init, wanted) {
  const lowered = wanted.toLowerCase()
  const collect = (headers) => {
    if (headers === undefined || headers === null) return undefined
    if (typeof headers.get === 'function') {
      const value = headers.get(lowered)
      return value === null ? undefined : value
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length < 2) continue
        if (String(pair[0]).toLowerCase() === lowered) return String(pair[1])
      }
      return undefined
    }
    if (isObject(headers)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lowered && headers[key] !== undefined) return String(headers[key])
      }
    }
    return undefined
  }
  const fromInit = collect(init && init.headers)
  if (fromInit !== undefined) return fromInit
  return collect(isObject(input) && input.headers ? input.headers : undefined)
}

/** 捕获请求/响应头时**必须脱敏**的字段：凭据绝不落盘。 */
const REDACT_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-auth-token', 'x-goog-api-key',
])
const MAX_CAPTURED_HEADERS = 40
const MAX_HEADER_VALUE = 512

/**
 * 把 Headers / 二维数组 / 普通对象统一成小写键的对象，脱敏 + 限长。
 * 用于存证「这条请求/响应到底带了什么头」——它是判定路由与客户端实现最直接的证据。
 */
function headersToObject (headers) {
  const out = {}
  if (headers === undefined || headers === null) return out
  let count = 0
  const put = (name, value) => {
    if (count >= MAX_CAPTURED_HEADERS) return
    const key = String(name).toLowerCase()
    if (key.length === 0 || key.length > 64) return
    if (Object.hasOwn(out, key)) return
    const text = value === undefined || value === null ? '' : String(value)
    out[key] = REDACT_HEADERS.has(key)
      ? '<redacted>'
      : text.length > MAX_HEADER_VALUE ? `${text.slice(0, MAX_HEADER_VALUE)}…` : text
    count += 1
  }
  try {
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((value, name) => put(name, value))       // Headers 实例
      return out
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length >= 2) put(pair[0], pair[1])
      }
      return out
    }
    if (isObject(headers)) {
      for (const [name, value] of Object.entries(headers)) put(name, value)
    }
  } catch {
    // 头对象形态异常时返回已收集到的部分
  }
  return out
}

/** 请求头：init.headers 优先，其次 input（Request）上的 headers。 */
function extractRequestHeaders (input, init) {
  const fromInit = headersToObject(init && init.headers)
  if (Object.keys(fromInit).length > 0) return fromInit
  return headersToObject(isObject(input) && input.headers ? input.headers : undefined)
}

/** 请求体只取 model 一个字段（不保留 prompt）。 */
function requestModelOf (init, input) {  let body = init && init.body
  if (typeof body === 'string' && body.length < 2 * 1024 * 1024) {
    try {
      const parsed = JSON.parse(body)
      if (isObject(parsed) && typeof parsed.model === 'string') return parsed.model
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 从原始响应字节里找 system_fingerprint（JSON 或 SSE 文本都适用）。 */
function extractFingerprint (text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const quoted = /"system_fingerprint"\s*:\s*"([0-9a-fA-F]{32})"/u.exec(text)
  if (quoted) return quoted[1].toLowerCase()
  return null
}

/**
 * 从响应头里取网关溯源证据（解码前就拿到，不必等正文）。没有任何一项时返回 null。
 *
 * 读哪些头由配置决定（见 normalizeGatewayHeaders）；`gateway.fields` 保留配置顺序，
 * 供 UI 与登记表按顺序展示；已知角色同时平铺在 `gateway[role]` 上（历史字段兼容）。
 *
 * @param {object} config 归一化后的配置
 * @param {Headers|undefined} headers
 */
function extractGateway (config, headers) {
  const mapping = isObject(config) ? config.gatewayHeaders : undefined
  if (!isObject(mapping) || mapping.enabled !== true) return null
  if (headers === undefined || headers === null || typeof headers.get !== 'function') return null
  const out = {}
  const fields = []
  for (const { key, header } of mapping.fields) {
    const value = headers.get(header)
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const text = value.trim()
    out[key] = text
    fields.push({ key, header, value: text })
  }
  if (fields.length === 0) return null
  out.source = 'headers'
  out.fields = fields
  return out
}

/** 响应 content-type（小写；缺失或非标准 Response 时返回空串）。 */
function contentTypeOf (response) {
  try {
    const value = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type')
      : null
    return typeof value === 'string' ? value.toLowerCase() : ''
  } catch {
    return ''
  }
}

function extractResponseModel (text, kind) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (kind === 'chat') {
    try {
      const parsed = JSON.parse(text)
      if (isObject(parsed) && typeof parsed.model === 'string') return parsed.model
    } catch {
      // 可能是被截断的 JSON，继续走正则
    }
    const match = /"model"\s*:\s*"([^"\\]+)"/u.exec(text)
    return match ? match[1] : undefined
  }
  const match = /"model"\s*:\s*"([^"\\]+)"/u.exec(text)
  return match ? match[1] : undefined
}

/**
 * 响应体里的补全 id。只取文本里第一个 `id`（JSON 顶层或 SSE 首个 data 块）——
 * 端点是透传原生 id 还是自己生成，形态不同，是端点的可观测特征。
 */
function extractResponseId (text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const head = text.length > 4096 ? text.slice(0, 4096) : text
  const match = /"id"\s*:\s*"([^"\\]{1,120})"/u.exec(head)
  return match ? match[1] : null
}

/** 读 clone 分支，最多 maxBytes；不阻塞原响应流。 */
async function readRawBody (response, maxBytes) {
  const clone = response.clone()
  if (!clone.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = clone.body.getReader()
  const chunks = []
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (bytes + value.byteLength > maxBytes) {
        chunks.push(Buffer.from(value.subarray(0, Math.max(0, maxBytes - bytes))))
        bytes = maxBytes
        truncated = true
        try {
          await reader.cancel()
        } catch {
          // 已关闭
        }
        break
      }
      chunks.push(Buffer.from(value))
      bytes += value.byteLength
    }
  } catch {
    // 流被中止：保留已读部分
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

function rawFileName (meta) {
  const stampText = stamp(new Date(meta.at))
  const kind = meta.kind === 'messages' ? 'messages' : meta.kind === 'chat' ? 'chat' : 'completion'
  const sessionTail = typeof meta.sessionId === 'string' && meta.sessionId.length > 0
    ? `-${meta.sessionId.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(-10)}`
    : ''
  // 网关（如 OpenCode Go）的 chat 路由永远是流式：按实际形态给扩展名，别把 SSE 存成 .json。
  const streamed = meta.streamed === true || kind === 'messages'
  return `${stampText}-${kind}${sessionTail}${meta.truncated ? '-trunc' : ''}.${streamed ? 'sse' : 'json'}`
}

async function pruneRawFiles (env) {
  if (env.pruning) return
  if (Date.now() - env.lastPruneAt < PRUNE_INTERVAL_MS) return
  env.pruning = true
  env.lastPruneAt = Date.now()
  try {
    const names = (await readdir(env.paths.raw))
      .filter((name) => name.endsWith('.sse') || name.endsWith('.json'))
      .sort()
    const excess = names.length - env.config.maxRawFiles
    if (excess > 0) {
      for (const name of names.slice(0, excess)) {
        try {
          await unlink(join(env.paths.raw, name))
        } catch {
          // 已被别的清理动作删掉
        }
      }
    }
  } catch {
    // 目录还没建好
  } finally {
    env.pruning = false
  }
}

function recordCapture (env, entry) {
  env.captureCount += 1
  env.entries.unshift(entry)
  if (env.entries.length > MAX_META_ENTRIES) env.entries.length = MAX_META_ENTRIES
  if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
    rememberBounded(env.lastBySession, entry.sessionId, entry, MAX_SESSION_RECORDS)
  }
  schedulePersist(env)
}

/**
 * 拦截一份响应：先 clone 原始字节落盘，再解析元数据。整个过程异步、不挡主响应。
 * @param {object} env
 * @param {Response} response
 * @param {object} context
 */
async function captureResponse (env, response, context) {
  const at = Date.now()
  const meta = {
    at,
    kind: context.kind,
    origin: context.sessionId ? 'session' : 'probe',
    /** 显式标记本插件自己的探测请求，避免与真实模型响应混淆。 */
    probe: context.probe === true,
    purpose: context.purpose ?? null,
    path: context.path,
    requestUrl: context.requestUrl ?? null,
    conversationBase: context.conversationBase ?? null,
    sessionId: context.sessionId ?? null,
    /** 会话 id 是从 harness 头还是网关会话头来的（决定溯源证据的可信度）。 */
    sessionIdSource: context.sessionIdSource ?? null,
    requestModel: context.requestModel ?? null,
    requestHeaders: context.requestHeaders ?? null,
    /** 响应头原文（脱敏后）：与请求头配对，用于核对网关回了哪些溯源字段。 */
    responseHeaders: env.config.captureHeaders ? headersToObject(response.headers) : null,
    responseModel: null,
    fingerprint: null,
    /** 网关溯源证据：即使上游不给 system_fingerprint，也留下「这次请求落到哪一层」。 */
    gateway: extractGateway(env.config, response.headers),
    /** 响应是不是流式（决定存证扩展名：SSE 不该叫 .json）。 */
    streamed: contentTypeOf(response).includes('text/event-stream'),
    traceId: response.headers.get('x-ds-trace-id') ?? response.headers.get('x-request-id') ?? null,
    status: response.status,
    rawFile: null,
    bytes: 0,
    truncated: false,
    saved: false,
    error: null,
  }
  try {
    const { buffer, truncated } = await readRawBody(response, env.config.maxRawBytes)
    meta.bytes = buffer.byteLength
    meta.truncated = truncated
    const text = buffer.toString('utf8')
    meta.fingerprint = extractFingerprint(text)
    meta.responseModel = extractResponseModel(text, context.kind) ?? null
    /** 响应 id：透传原生 id 的端点与网关生成 id 的端点，形态不同（见 responseIdFamily）。 */
    meta.responseId = extractResponseId(text)
    // content-type 缺失时按内容兜底判断流式（有些网关不回 content-type）。
    if (meta.streamed !== true && /^data:\s*\{/u.test(text)) meta.streamed = true
    // 原始字节是否落盘由 captureRaw 单独控制（默认关：隐私优先）。不落盘时元数据照样记，
    // 指纹仍从内存里的原始文本解析——「已拦截的真实响应指纹」这条能力不依赖存证文件。
    if (env.config.captureRaw && buffer.byteLength > 0) {
      await mkdir(env.paths.raw, { recursive: true })
      const fileName = rawFileName({ ...meta, truncated })
      await writeFile(join(env.paths.raw, fileName), buffer)
      meta.rawFile = join(RAW_SUBDIR, fileName)
      meta.saved = true
    }
  } catch (error) {
    meta.error = messageOf(error)
  }
  recordCapture(env, meta)
  // 网关溯源证据同时折进「路由端点登记表」：持续记录哪些上游端点出现过。
  if (accumulateEndpoint(env, meta)) schedulePersist(env)
  // 记住「这个会话的真实请求走了哪一层」，之后探测优先发到同一同源根。
  if (typeof meta.sessionId === 'string' && meta.sessionId.length > 0 && typeof meta.conversationBase === 'string' && meta.conversationBase.length > 0) {
    rememberBounded(env.lastRequestBySession, meta.sessionId, {
      at: meta.at,
      requestUrl: meta.requestUrl,
      conversationBase: meta.conversationBase,
      requestModel: meta.requestModel,
      harnessUserId: context.harnessUserId ?? null,
    }, MAX_SESSION_RECORDS)
  }
  void pruneRawFiles(env)
  return meta
}

/** 是否需要拦截这份请求。 */
function captureTargetOf (env, input, init) {
  if (!env.config.capture) return null
  const urlText = requestURLOf(input)
  if (urlText.length === 0) return null
  let parsed
  try {
    parsed = new URL(urlText)
  } catch {
    return null
  }
  const kind = classifyApiPath(parsed.pathname)
  if (kind === null) return null
  const isProbe = headerFrom(input, init, 'x-dsh-system-fingerprint-probe') === '1'
  const harnessSessionId = headerFrom(input, init, 'x-deepseek-harness-session-id')
  const gatewaySessionHeader = env.config.gatewaySessionHeader
  const gatewaySessionId = gatewaySessionHeader === null ? undefined : headerFrom(input, init, gatewaySessionHeader)
  // 网关路由（pi-ai 适配器）不发 x-deepseek-harness-*，改用网关自己的会话头把响应
  // 关联回 DSH 会话——两边取到的都是同一个会话 id。
  const sessionId = harnessSessionId ?? gatewaySessionId ?? null
  const sessionIdSource = isProbe
    ? null
    : harnessSessionId !== undefined ? 'harness' : gatewaySessionId !== undefined ? 'gateway' : null
  const harnessUserId = headerFrom(input, init, 'x-deepseek-harness-user-id') ?? null
  // 可信范围：配置/环境里的 host，或者带 DSH 会话头的请求——后者意味着对话走了自定义
  // baseURL / 网关（适配器仍会带 x-deepseek-harness-* 头），这类端点必须同样拦截，
  // 否则「同源探测」就永远看不到真实端点。
  const trusted = env.config.captureHosts.has(parsed.host.toLowerCase()) || sessionId !== null || harnessUserId !== null
  if (!trusted) return null
  return {
    kind,
    path: parsed.pathname,
    requestUrl: parsed.href,
    conversationBase: deriveConversationBase(parsed.href),
    // 探测请求即便带会话头也不归到会话流量里：否则会污染「最近真实对话响应」证据。
    sessionId: isProbe ? null : sessionId,
    /** 会话 id 的来源：harness 头（DeepSeek 适配器）还是网关会话头。 */
    sessionIdSource: isProbe ? null : sessionIdSource,
    harnessUserId: isProbe ? null : harnessUserId,
    probe: isProbe,
    purpose: isProbe ? 'probe' : headerFrom(input, init, 'x-deepseek-harness-compact') === '1' ? 'compaction' : null,
    requestModel: requestModelOf(init, input) ?? null,
    /** 请求头原文（脱敏后）：判定「谁发的、走哪条路由」最直接的证据。 */
    requestHeaders: env.config.captureHeaders ? extractRequestHeaders(input, init) : null,
  }
}

/** 补丁在自身上记录它包住的原始 fetch，供重新应用时无损重装。 */
const PATCH_ORIGINAL = Symbol.for('dsh.system-fingerprint.fetch-original')
const FETCH_PATCH_MARK = Symbol.for('dsh.system-fingerprint.fetch-patched')

/**
 * 给宿主进程的 globalThis.fetch 套一层只读拦截。返回卸载函数。
 *
 * 重新启用 bundle（新模块实例）时既不套娃、也不把旧实现留在链上：
 * 在位的是本插件的补丁（自身上记录了被它包住的原始 fetch）→ 直接摘掉它、用当前代码重装。
 * 这一点很重要——「只换 env」是不够的：旧补丁的闭包还持有它自己那份 captureResponse，
 * 改宿主代码后不重装就等于没改。
 *
 * 例外：v1 时代的补丁没有 `PATCH_ORIGINAL` 记录，只能叠一层（跨版本热升级的边角情况，
 * 表现为 api.deepseek.com 的存证可能被记两次，重启 dsh 即消失）。
 */
function installFetchCapture (env) {
  const globalObject = globalThis
  const current = globalObject.fetch
  if (typeof current !== 'function') return () => {}
  const original = typeof current[PATCH_ORIGINAL] === 'function' ? current[PATCH_ORIGINAL] : current

  const patched = async function patchedFetch (input, init) {
    const response = await original.call(this, input, init)
    try {
      const target = captureTargetOf(env, input, init)
      if (target !== null && response && typeof response === 'object' && typeof response.clone === 'function') {
        void captureResponse(env, response, target)
      }
    } catch {
      // 拦截失败绝不影响真实请求
    }
    return response
  }
  patched[FETCH_PATCH_MARK] = true
  patched[PATCH_ORIGINAL] = original
  globalObject.fetch = patched
  return () => {
    if (globalObject.fetch === patched) globalObject.fetch = original
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模型来源解析（会话投影 → 拦截到的 llm/stream → 默认模型 → 配置）
// ─────────────────────────────────────────────────────────────────────────────

function selectionFromSession (ctx, sessionId) {
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (!sessions || typeof sessions.get !== 'function') return undefined
    const session = sessions.get(sessionId)
    if (!session) return undefined
    const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
    if (!projections || typeof projections.stateOf !== 'function') return undefined
    const state = projections.stateOf(session, 'modelSelection')
    if (!isObject(state)) return undefined
    const selection = state.pending ?? state.next ?? state.lastUsed
    if (!isObject(selection)) return undefined
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      source: 'session',
    }
  } catch {
    return undefined
  }
}

function defaultSelectionOf (ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    if (!service || typeof service.currentSelection !== 'function') return undefined
    const selection = service.currentSelection()
    if (!isObject(selection)) return undefined
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, source: 'default' }
  } catch {
    return undefined
  }
}

/**
 * 解析本次要探测的 provider/model。优先级：
 * 客户端给的 query > 会话模型投影 > 拦截到的 llm/stream 调用 > 默认模型 > 插件配置。
 * 单项缺失时用下一层补齐（例如只给了 model 的情况）。
 */
function resolveTarget (env, params) {
  const sessionId = typeof params.sessionId === 'string' && params.sessionId.length > 0 ? params.sessionId : undefined
  const queryProvider = stringOr(params.provider, '')
  const queryModel = stringOr(params.model, '')
  const candidates = []
  if (sessionId) {
    const fromSession = selectionFromSession(env.ctx, sessionId)
    if (fromSession) candidates.push(fromSession)
    const intercepted = env.lastCallBySession.get(sessionId)
    if (isObject(intercepted) && typeof intercepted.provider === 'string' && typeof intercepted.model === 'string') {
      candidates.push({ provider: intercepted.provider, model: intercepted.model, reasoningEffort: intercepted.reasoningEffort, source: 'intercepted' })
    }
  }
  const fallbackDefault = defaultSelectionOf(env.ctx)
  if (fallbackDefault) candidates.push(fallbackDefault)
  candidates.push({ provider: env.config.provider, model: env.config.model, source: 'config' })

  const pick = candidates.find((candidate) =>
    (queryProvider === '' || candidate.provider === queryProvider) &&
    (queryModel === '' || candidate.model === queryModel)) ?? candidates[0]
  const provider = queryProvider !== '' ? queryProvider : pick.provider
  const model = queryModel !== '' ? queryModel : pick.model
  const matched = candidates.find((candidate) => candidate.provider === provider && candidate.model === model)
  return {
    provider,
    model,
    reasoningEffort: matched?.reasoningEffort,
    source: queryProvider !== '' || queryModel !== '' ? 'client' : (matched?.source ?? pick.source),
    sessionId,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主动探测
// ─────────────────────────────────────────────────────────────────────────────

/** credential ref 解析：credentials 服务优先，启动环境变量兜底；不落日志。 */
async function resolveApiKey (env) {
  try {
    const credentials = typeof env.ctx.get === 'function' ? env.ctx.get('credentials') : undefined
    if (credentials && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(env.config.apiKeyEnv)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
  } catch {
    // 服务缺失或解析失败 → 环境变量兜底
  }
  const ambient = process.env[env.config.apiKeyEnv]
  if (typeof ambient === 'string' && ambient.trim().length > 0) return ambient.trim()
  return null
}

function httpProbeError (status, headers, text) {
  let detail = ''
  try {
    const parsed = JSON.parse(text)
    if (isObject(parsed)) {
      const message = isObject(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : typeof parsed.message === 'string' ? parsed.message : ''
      if (message.length > 0) detail = `：${message.slice(0, 200)}`
    }
  } catch {
    // 非 JSON 错误体
  }
  if (status === 401 || status === 403) {
    return new FingerprintError('unauthorized', `凭据被上游拒绝（HTTP ${status}）${detail}`, { status })
  }
  if (status === 429) {
    const retryAfter = Number(headers?.get?.('retry-after'))
    return new FingerprintError('rate-limited', `上游限流（HTTP 429）${detail}`, {
      status,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    })
  }
  if (status >= 500) {
    return new FingerprintError('server', `上游错误（HTTP ${status}）${detail}`, { status })
  }
  return new FingerprintError('http-client', `探测请求被拒绝（HTTP ${status}）${detail}`, { status })
}

function probeFailure (error) {
  if (error instanceof FingerprintError) {
    return { code: error.code, message: error.message, ...error.extra }
  }
  return { code: 'internal', message: messageOf(error) }
}

/**
 * 探测端点候选：优先「本会话真实对话请求的同源根」，其次配置项，最后环境推导根。
 * 这样如果对话走的是用户自己的网关/转发，探测会先走同一个网关入口，而不是绕开它直连官方。
 * @param {object} env
 * @param {object} target - { sessionId, model, provider }
 * @returns {Array<{baseURL:string,source:string,conversationHost?:string,headers?:object}>}
 */
function probeEndpointCandidates (env, target) {
  const candidates = []
  const seen = new Set()
  const push = (baseURL, source, extra = {}) => {
    const normalized = trimBaseURL(baseURL)
    if (normalized.length === 0 || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push({ baseURL: normalized, source, ...extra })
  }

  const observed = target.sessionId ? env.lastRequestBySession.get(target.sessionId) : undefined
  const conversationHost = observed && observed.conversationBase ? hostOf(observed.conversationBase) : undefined
  if (observed && typeof observed.conversationBase === 'string' && observed.conversationBase.length > 0) {
    // 把对话用过的会话头一起发给探测请求：按 session 头做转发的网关会因此路由到同一层。
    const headers = { 'x-deepseek-harness-session-id': String(target.sessionId) }
    if (typeof observed.harnessUserId === 'string' && observed.harnessUserId.length > 0) {
      headers['x-deepseek-harness-user-id'] = observed.harnessUserId
    }
    push(observed.conversationBase, 'observed', {
      conversationHost,
      conversationUrl: observed.requestUrl ?? null,
      headers,
    })
    // 有些网关把对话与 OpenAI 兼容路由放在不同前缀：再试同 origin 根。
    try {
      const origin = new URL(observed.conversationBase).origin
      push(origin, 'observed-origin', {
        conversationHost,
        conversationUrl: observed.requestUrl ?? null,
        headers,
      })
    } catch {
      // ignore
    }
  }
  push(env.config.openaiBaseURL, 'config', { conversationHost })
  push(defaultOpenAIBaseURL(), 'env-default', { conversationHost })
  return candidates
}

/** OpenAI 兼容端点路径候选：base 已以 /v1 结尾时只试 /chat/completions。 */
function probePaths (baseURL) {
  const base = trimBaseURL(baseURL)
  return /\/v1$/u.test(base) ? ['/chat/completions'] : ['/chat/completions', '/v1/chat/completions']
}

/** 换端点意味着可能换了一层；只有「端点不存在 / 网络不可达」才继续尝试下一候选。 */
function shouldTryNextEndpoint (error) {
  if (!(error instanceof FingerprintError)) return false
  return error.code === 'endpoint-unavailable' || error.code === 'network'
}

/** 发一次最小探测请求；5xx 重试一次。candidate 指定「同一层」的端点根。 */
async function probeOnce (env, model, candidate, apiPath) {
  const apiKey = await resolveApiKey(env)
  if (apiKey === null || apiKey.length === 0) {
    throw new FingerprintError('missing-credential', `未找到凭据 ${env.config.apiKeyEnv}（credentials 服务与环境变量均未提供）`)
  }
  const endpoint = `${trimBaseURL(candidate.baseURL)}${apiPath}`
  const endpointInfo = {
    baseURL: trimBaseURL(candidate.baseURL),
    host: hostOf(candidate.baseURL),
    source: candidate.source,
    apiPath,
    conversationHost: candidate.conversationHost ?? null,
    sessionHeaderForwarded: isObject(candidate.headers),
  }
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let timeoutSignal
    try {
      timeoutSignal = AbortSignal.timeout(env.config.timeoutMs)
    } catch {
      timeoutSignal = undefined
    }
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // 本插件自己的探测请求：即使带了会话头（为了网关按会话路由），也要和真实对话流量区分开。
          'x-dsh-system-fingerprint-probe': '1',
          ...(isObject(candidate.headers) ? candidate.headers : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          stream: false,
          messages: [{ role: 'user', content: PROBE_HELLO }],
        }),
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      })
    } catch (error) {
      lastError = error
      if (attempt === 0) {
        await delay(200)
        continue
      }
      if (isTimeoutError(error)) {
        throw new FingerprintError('timeout', `探测超时（${env.config.timeoutMs}ms）：${endpointInfo.host ?? endpoint}`)
      }
      throw new FingerprintError('network', `探测请求失败：${messageOf(error)}（${endpointInfo.host ?? endpoint}）`)
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      if (response.status >= 500 && attempt === 0) {
        await delay(250)
        continue
      }
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        throw new FingerprintError(
          'endpoint-unavailable',
          `探测端点不可用（HTTP ${response.status}）：${endpointInfo.host ?? endpoint}${apiPath}`,
          { status: response.status },
        )
      }
      throw httpProbeError(response.status, response.headers, text)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new FingerprintError('invalid-response', '探测响应不是合法 JSON')
    }
    const fingerprint = isObject(body) && typeof body.system_fingerprint === 'string'
      ? body.system_fingerprint.trim().toLowerCase()
      : ''
    if (!/^[0-9a-f]{32}$/u.test(fingerprint)) {
      throw new FingerprintError('missing-field', '探测响应里没有 system_fingerprint 字段')
    }
    return {
      systemFingerprint: fingerprint,
      modelEcho: isObject(body) && typeof body.model === 'string' ? body.model : undefined,
      traceId: response.headers.get('x-ds-trace-id') ?? response.headers.get('x-request-id') ?? undefined,
      at: Date.now(),
      endpoint: endpointInfo,
    }
  }
  throw lastError instanceof Error ? lastError : new FingerprintError('network', '探测请求失败')
}

/** 稳定性校验（可选）：同请求若干次，指纹一致才算 stable。 */
async function runProbe (env, model, candidate, apiPath) {
  const checks = env.config.stabilityChecks
  const seen = []
  let first
  for (let index = 0; index < checks; index += 1) {
    if (index > 0) await delay(120)
    const result = await probeOnce(env, model, candidate, apiPath)
    first = first ?? result
    seen.push(result.systemFingerprint)
  }
  first.stable = checks > 1 ? seen.every((value) => seen[0] === value) : null
  first.checks = checks
  first.cached = false
  return first
}

/**
 * 对照「本会话真实请求端点」评估这次探测结果与对话同层的可信度。
 * @returns {{confidence:'high'|'medium'|'low', confidenceNote:string}}
 */
function endpointConfidence (env, target, endpoint) {
  const observed = target.sessionId ? env.lastRequestBySession.get(target.sessionId) : undefined
  if (!observed || typeof observed.conversationBase !== 'string' || observed.conversationBase.length === 0) {
    return {
      confidence: 'low',
      confidenceNote: '尚未拦截到本会话的真实请求，探测端点来自配置；无法确认与对话同层',
    }
  }
  if (endpoint.source === 'observed') {
    return {
      confidence: 'high',
      confidenceNote: endpoint.sessionHeaderForwarded === true
        ? '探测端点取自本会话真实请求的同源根，并带上会话头，尽量走同一层'
        : '探测端点取自本会话真实请求的同源根',
    }
  }
  if (endpoint.host !== undefined && endpoint.host === hostOf(observed.conversationBase)) {
    return {
      confidence: 'medium',
      confidenceNote: '探测端点与对话同 host，但来自配置层',
    }
  }
  return {
    confidence: 'low',
    confidenceNote: '本会话真实端点探测失败，已回退到配置端点（与对话不同源，若存在按会话转发则结果可能不代表该对话）',
  }
}

/** 按候选顺序探测；端点不存在/网络不可达时换下一个候选，其余错误立即上报。 */
async function probeWithCandidates (env, target, candidates) {
  const attempts = []
  let lastError
  for (const candidate of candidates) {
    for (const apiPath of probePaths(candidate.baseURL)) {
      try {
        const result = await runProbe(env, target.model, candidate, apiPath)
        result.endpoint.attempts = attempts.concat([{
          baseURL: candidate.baseURL,
          apiPath,
          source: candidate.source,
          outcome: 'ok',
        }])
        const assessment = endpointConfidence(env, target, result.endpoint)
        result.confidence = assessment.confidence
        result.confidenceNote = assessment.confidenceNote
        return result
      } catch (error) {
        lastError = error
        attempts.push({
          baseURL: candidate.baseURL,
          apiPath,
          source: candidate.source,
          outcome: 'failed',
          code: error instanceof FingerprintError ? error.code : 'internal',
          ...(error instanceof FingerprintError && error.extra?.status !== undefined ? { status: error.extra.status } : {}),
        })
        if (!shouldTryNextEndpoint(error)) {
          if (error instanceof FingerprintError) error.extra = { ...error.extra, endpointAttempts: attempts }
          throw error
        }
      }
    }
  }
  if (lastError instanceof FingerprintError) {
    lastError.extra = { ...lastError.extra, endpointAttempts: attempts }
    throw lastError
  }
  throw new FingerprintError('network', '没有可用的探测端点', { endpointAttempts: attempts })
}

function probeCacheKey (target, baseURL) {
  return `${target.model}\u0000${baseURL}\u0000${target.sessionId ?? ''}`
}

/** 带 TTL 缓存 + 并发去重的探测；缓存按「端点 + 会话」隔离，避免跨层的凭证/路由混用。 */
async function probeCached (env, target, force) {
  const candidates = probeEndpointCandidates(env, target)
  const now = Date.now()
  if (!force) {
    for (const candidate of candidates) {
      const cached = env.probeCache.get(probeCacheKey(target, candidate.baseURL))
      if (!cached) continue
      if (cached.value !== undefined && now < cached.valueExpiresAt) {
        const value = cached.value
        // 同一 baseURL 可能先是配置探测、后升级成「本会话真实请求同源」；命中缓存也要修正来源。
        return {
          ...value,
          cached: true,
          endpoint: {
            ...value.endpoint,
            source: candidate.source,
            conversationHost: candidate.conversationHost ?? value.endpoint.conversationHost ?? null,
            sessionHeaderForwarded: isObject(candidate.headers),
          },
        }
      }
      if (cached.error !== undefined && now < cached.errorExpiresAt) throw cached.error
    }
    const inflight = env.probeInflight.get(probeCacheKey(target, candidates[0].baseURL))
    if (inflight !== undefined) return inflight
  }
  const inflightKey = probeCacheKey(target, candidates[0].baseURL)
  const promise = probeWithCandidates(env, target, candidates)
    .then((value) => {
      env.lastProbe = {
        model: target.model,
        provider: env.config.provider,
        systemFingerprint: value.systemFingerprint,
        modelEcho: value.modelEcho,
        traceId: value.traceId,
        at: value.at,
        stable: value.stable,
        checks: value.checks,
        endpointHost: value.endpoint?.host ?? null,
        endpointSource: value.endpoint?.source ?? null,
        confidence: value.confidence ?? null,
      }
      env.probeCache.set(probeCacheKey(target, value.endpoint?.baseURL ?? candidates[0].baseURL), {
        value,
        valueExpiresAt: Date.now() + env.config.cacheTtlMs,
        errorExpiresAt: 0,
      })
      // 探测成功 → 刷新只读配置导出里的 checkpoint 绑定（外部采集器读它对齐「指纹↔行为模板」）。
      void persistConfigExport(env)
      return value
    })
    .catch((error) => {
      env.probeCache.set(inflightKey, { error, valueExpiresAt: 0, errorExpiresAt: Date.now() + env.config.errorTtlMs })
      throw error
    })
    .finally(() => {
      env.probeInflight.delete(inflightKey)
    })
  env.probeInflight.set(inflightKey, promise)
  return promise
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果组装
// ─────────────────────────────────────────────────────────────────────────────

function mapFingerprint (config, fingerprint) {
  if (typeof fingerprint !== 'string') return null
  return config.tableByFingerprint.get(fingerprint.toLowerCase()) ?? null
}

/** 对指定会话/model 找「已拦截原始响应」里的指纹（有就用实际响应，而不是探测）。 */
function findRecordedFingerprint (env, sessionId, model) {
  if (sessionId === undefined) return null
  for (const entry of env.entries) {
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) continue
    // 探针请求（哪怕旧版本曾带会话头）不能被当成「真实对话响应」的证据。
    if (entry.probe === true || entry.purpose === 'probe') continue
    // 旧版存证没有 probe 字段：chat 类条目无法区分「chat 探针」与「OpenAI 兼容真实响应」，
    // 一律跳过；messages 类条目就是真实对话响应，保留。
    if (entry.kind !== 'messages' && entry.probe !== false) continue
    if (entry.sessionId !== sessionId) continue
    if (model && entry.requestModel && entry.requestModel !== model && entry.responseModel !== model) continue
    return entry
  }
  return null
}

/** 探测失败时的兜底：同 model 的历史指纹（来自上次探测的存证）。 */
function findStaleFingerprint (env, model) {
  for (const entry of env.entries) {
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) continue
    if (model && entry.requestModel && entry.requestModel !== model) continue
    return entry
  }
  return null
}

/** 一条存证是不是「真实会话 + 带网关溯源」的可用证据。 */
function isGatewayEvidence (entry) {
  if (!isObject(entry.gateway)) return false
  if (entry.probe === true || entry.purpose === 'probe') return false
  return true
}

/**
 * 找本会话真实响应里留下的网关溯源证据。
 *
 * 优先按会话关联（网关路由经 x-opencode-session 带同一个会话 id）；关联缺失时按
 * model + 新鲜度兜底，并把 matchedBy 标成 model —— 那种情况下证据不属于本会话，
 * 可信度要在结果里降级。
 */
function findRecordedGateway (env, sessionId, model) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const bySession = env.entries.find((entry) => isGatewayEvidence(entry) && entry.sessionId === sessionId)
    if (bySession !== undefined) return { entry: bySession, matchedBy: 'session' }
  }
  if (typeof model === 'string' && model.length > 0) {
    const byModel = env.entries.find((entry) => {
      if (!isGatewayEvidence(entry)) return false
      if (Date.now() - entry.at > GATEWAY_MATCH_TTL_MS) return false
      return entry.responseModel === model || entry.requestModel === model
    })
    if (byModel !== undefined) return { entry: byModel, matchedBy: 'model' }
  }
  return null
}

function captureSummaryOf (env, sessionId) {
  const sessionEntries = sessionId === undefined
    ? []
    : env.entries.filter((entry) => entry.sessionId === sessionId && entry.probe !== true && entry.purpose !== 'probe')
  const last = sessionEntries[0] ?? env.entries[0] ?? null
  const captureEnabled = env.config.capture
  const rawEnabled = env.config.capture && env.config.captureRaw
  return {
    /** 响应拦截（响应头/元数据证据）是否开启。 */
    enabled: captureEnabled,
    /** 原始字节是否落盘（默认关：隐私优先）。 */
    rawEnabled,
    headersEnabled: env.config.captureHeaders,
    total: env.captureCount,
    sessionTotal: sessionEntries.length,
    dir: rawEnabled ? `${env.paths.displayRoot}/${RAW_SUBDIR}` : null,
    muting: !captureEnabled ? 'capture-disabled' : rawEnabled ? null : 'capture-raw-disabled',
    last: last === null ? null : {
      at: last.at,
      kind: last.kind,
      origin: last.origin,
      purpose: last.purpose ?? null,
      status: last.status,
      bytes: last.bytes,
      truncated: last.truncated === true,
      saved: last.saved === true,
      hasFingerprint: typeof last.fingerprint === 'string' && last.fingerprint.length > 0,
      traceId: last.traceId ?? null,
      rawFile: last.rawFile ?? null,
    },
  }
}

/**
 * 归一化外部告警文件（通用 schema v1）。只接受白名单字段；任何不合法都返回 null。
 * 这是**可选输入**：插件不关心谁写它，也不依赖产出方。
 */
function normalizeExternalAlert (payload) {
  if (!isObject(payload)) return null
  if (payload.version !== ALERT_SCHEMA_VERSION) return null
  const ALLOWED_LEVELS = new Set(['ok', 'info', 'warn', 'critical'])
  if (typeof payload.level !== 'string' || !ALLOWED_LEVELS.has(payload.level)) return null
  if (typeof payload.verdict !== 'string' || payload.verdict.length === 0) return null
  const subject = isObject(payload.subject) ? payload.subject : {}
  const checkpoint = isObject(subject.checkpoint) ? subject.checkpoint : null
  const signals = Array.isArray(payload.signals)
    ? payload.signals.filter(isObject).slice(0, 12).map((signal) => ({
        channel: stringOr(signal.channel, 'unknown'),
        verdict: stringOr(signal.verdict, 'unknown'),
        detail: typeof signal.detail === 'string' ? signal.detail.slice(0, 300) : '',
      }))
    : []
  const caveats = Array.isArray(payload.caveats)
    ? payload.caveats.filter((value) => typeof value === 'string').slice(0, 8).map((value) => value.slice(0, 300))
    : []
  return {
    version: ALERT_SCHEMA_VERSION,
    level: payload.level,
    verdict: payload.verdict,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 500) : '',
    updatedAt: Number.isFinite(payload.updatedAt) ? payload.updatedAt : null,
    subject: {
      provider: subject.provider === undefined ? null : String(subject.provider),
      model: subject.model === undefined ? null : String(subject.model),
      checkpoint: checkpoint === null ? null : {
        name: typeof checkpoint.name === 'string' ? checkpoint.name : null,
        fingerprint: typeof checkpoint.fingerprint === 'string' ? checkpoint.fingerprint : null,
      },
    },
    signals,
    caveats,
  }
}

/**
 * 读可选的外部告警文件（display-only）。缓存 15s，按 mtime 失效；任何错误都降级为 null。
 * @param {object} env
 */
async function readExternalAlert (env) {
  const file = env.config.externalAlertFile
  if (file === null) return null
  const now = Date.now()
  if (isObject(env.alertCache) && now - env.alertCache.checkedAt < ALERT_CACHE_TTL_MS) {
    return env.alertCache.value
  }
  let value = null
  try {
    const text = await readFile(file, 'utf8')
    value = normalizeExternalAlert(JSON.parse(text))
  } catch {
    value = null
  }
  env.alertCache = { checkedAt: now, value }
  return value
}

function valueOf (env, target, source, data, extra = {}) {
  const fingerprint = data.systemFingerprint
  const checkpoint = mapFingerprint(env.config, fingerprint)
  return {
    ok: true,
    value: {
      supported: true,
      provider: target.provider,
      requestedModel: target.model,
      model: data.modelEcho ?? target.model,
      reasoningEffort: target.reasoningEffort ?? null,
      modelSource: target.source,
      systemFingerprint: fingerprint,
      fingerprintSource: source,
      checkpoint: checkpoint === null ? null : { name: checkpoint.name, plaintext: checkpoint.plaintext },
      display: checkpoint === null ? fingerprint : checkpoint.name,
      displayKind: checkpoint === null ? 'fingerprint' : 'checkpoint',
      probedAt: data.at,
      ageMs: Math.max(0, Date.now() - data.at),
      traceId: data.traceId ?? null,
      stable: data.stable ?? null,
      checks: data.checks ?? null,
      cached: data.cached === true,
      stale: extra.stale === true,
      staleReason: extra.staleReason ?? null,
      /** 探测实际走的端点层：observed=本会话真实请求同源根；config/env-default=配置回退。 */
      endpoint: data.endpoint ?? null,
      /** 与对话同层的可信度：high（同源推导）/ medium（同 host）/ low（无证据或回退）。 */
      confidence: data.confidence ?? null,
      confidenceNote: data.confidenceNote ?? null,
      capture: captureSummaryOf(env, target.sessionId),
      tableSize: env.config.checkpoints.length,
      note: source === 'response'
        ? '来自已拦截的真实响应；被拦截的是解码前原始字节'
        : '当前后端配置指纹，非历史响应指纹',
    },
  }
}

/**
 * 取网关溯源字段：新存证带 `fields`（按配置顺序，含自定义角色），
 * 升级前的旧存证没有 fields，就从已知角色平铺字段拼出来（保证旧 meta.json 也能展示）。
 */
function gatewayFieldsOf (gateway) {
  if (!isObject(gateway)) return []
  if (Array.isArray(gateway.fields) && gateway.fields.length > 0) return gateway.fields
  const out = []
  for (const [key, header] of Object.entries(DEFAULT_GATEWAY_HEADERS)) {
    const value = gateway[key]
    if (typeof value === 'string' && value.length > 0) out.push({ key, header, value })
  }
  return out
}

/**
 * 网关溯源模式的结果成形。
 *
 * `supported` 保持 false：**指纹维度确实不支持**（上游不发布该字段），只是把实测到的
 * 请求级溯源头作为替代表达出来——绝不拿别的路由的检查点来冒充本会话指纹。
 */
function valueOfGateway (env, target, hit) {
  const entry = hit.entry
  const gateway = entry.gateway
  const sameSession = hit.matchedBy === 'session'
  const host = typeof entry.conversationBase === 'string' ? hostOf(entry.conversationBase) : undefined
  // 徽标主显示：配置里第一个有值的溯源字段（默认就是 endpointId 后端池）。
  const fieldList = gatewayFieldsOf(gateway)
  const display = fieldList.length > 0 ? fieldList[0].value : entry.responseModel ?? target.model
  return {
    ok: true,
    value: {
      supported: false,
      reason: 'gateway-provenance',
      displayKind: 'gateway',
      display,
      provider: target.provider,
      requestedModel: target.model,
      model: entry.responseModel ?? entry.requestModel ?? target.model,
      reasoningEffort: target.reasoningEffort ?? null,
      modelSource: target.source,
      /** 指纹维度：上游不发布，明确标成不可用，而不是留空让人误读。 */
      fingerprint: {
        available: false,
        systemFingerprint: null,
        checkpoint: null,
        reason: 'upstream-no-system-fingerprint',
      },
      gateway: {
        /** 配置顺序的完整溯源字段（含自定义角色），UI 按这个渲染。 */
        fields: fieldList.map((field) => ({ key: field.key, value: field.value })),
        /** 已知角色同时平铺，保持旧字段兼容（外部脚本可能直接读这些键）。 */
        endpointId: gateway.endpointId ?? null,
        upstreamModelId: gateway.upstreamModelId ?? null,
        logId: gateway.logId ?? null,
        zenModel: gateway.zenModel ?? null,
        placement: gateway.placement ?? null,
        rayId: gateway.rayId ?? null,
        at: entry.at,
        ageMs: Math.max(0, Date.now() - entry.at),
        sessionId: entry.sessionId ?? null,
        sessionIdSource: entry.sessionIdSource ?? null,
        matchedBy: hit.matchedBy,
        requestPath: entry.path ?? null,
        endpointHost: host ?? null,
      },
      probedAt: entry.at,
      ageMs: Math.max(0, Date.now() - entry.at),
      traceId: entry.traceId ?? gateway.logId ?? null,
      endpoint: host === undefined
        ? null
        : {
            baseURL: entry.conversationBase,
            host,
            source: 'observed',
            apiPath: entry.path ?? null,
            conversationHost: host,
            sessionHeaderForwarded: entry.sessionIdSource === 'gateway',
            attempts: [{ baseURL: entry.conversationBase, apiPath: entry.path ?? null, source: 'observed', outcome: 'ok' }],
          },
      confidence: sameSession ? 'high' : 'medium',
      confidenceNote: sameSession
        ? '来自本会话真实响应头（解码前拦截）'
        : '按 model + 时间窗匹配到网关响应头，未确认属于本会话',
      capture: captureSummaryOf(env, target.sessionId),
      tableSize: env.config.checkpoints.length,
      note: '该上游不返回 system_fingerprint；以下是请求级网关溯源，标识请求落到哪个后端池',
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 状态路由
// ─────────────────────────────────────────────────────────────────────────────

function searchParamsOf (request) {
  try {
    return new URL(request.url).searchParams
  } catch {
    try {
      return new URL(String(request.url ?? '/'), 'http://localhost').searchParams
    } catch {
      return new URLSearchParams()
    }
  }
}

/**
 * GET /api/system-fingerprint/state 的内部实现（响应体在 handleState 里统一包 apiVersion）。
 * query: sessionId、provider、model、refresh=1
 * 返回纯 JSON（HTTP 200）：
 *   { ok: true, value: {...} } | { ok: false, error: { code, message }, value?: {...} }
 */
async function handleStateResult (env, request) {
  let params
  try {
    const search = searchParamsOf(request)
    params = {
      sessionId: search.get('sessionId') ?? undefined,
      provider: search.get('provider') ?? undefined,
      model: search.get('model') ?? undefined,
      force: search.get('refresh') === '1',
    }
  } catch (error) {
    return { ok: false, error: { code: 'bad-request', message: messageOf(error) } }
  }

  const target = resolveTarget(env, params)
  const capture = captureSummaryOf(env, target.sessionId)

  // 1) 已拦截到的实际响应里带指纹 → 优先用实际响应（语义比探测更强，也不受 provider 限制）。
  const recorded = findRecordedFingerprint(env, target.sessionId, target.model)
  if (recorded !== null) {
    const recordedHost = recorded.conversationBase ? hostOf(recorded.conversationBase) : null
    return valueOf(env, target, 'response', {
      systemFingerprint: recorded.fingerprint,
      modelEcho: recorded.responseModel ?? recorded.requestModel ?? target.model,
      traceId: recorded.traceId ?? undefined,
      at: recorded.at,
      stable: null,
      checks: null,
      cached: true,
      endpoint: recordedHost === null ? null : {
        baseURL: recorded.conversationBase,
        host: recordedHost,
        source: 'observed',
        apiPath: recorded.path ?? null,
        conversationHost: recordedHost,
        sessionHeaderForwarded: false,
        attempts: [{ baseURL: recorded.conversationBase, apiPath: recorded.path ?? null, source: 'observed', outcome: 'ok' }],
      },
      confidence: 'high',
      confidenceNote: '指纹直接来自本会话真实响应（解码前原始字节）',
    })
  }

  if (target.provider !== env.config.provider) {
    // 1b) 网关路由（上游不发布 system_fingerprint）：如果本会话真实响应里留了溯源证据，
    // 就用实测证据回答，而不是干巴巴一句「不适用」。
    const gateway = findRecordedGateway(env, target.sessionId, target.model)
    if (gateway !== null) return valueOfGateway(env, target, gateway)
    return {
      ok: true,
      value: {
        supported: false,
        reason: 'provider-not-probeable',
        provider: target.provider,
        requestedModel: target.model,
        modelSource: target.source,
        probeProvider: env.config.provider,
        endpoint: null,
        confidence: null,
        confidenceNote: null,
        capture,
        note: `仅对 ${env.config.provider} 路由做 system_fingerprint 探测`,
      },
    }
  }

  // 2) 主动探测（带缓存）。
  try {
    const probe = await probeCached(env, target, params.force)
    return valueOf(env, target, 'probe', probe)
  } catch (error) {
    const failure = probeFailure(error)
    // 3) 探测失败时的兜底：同 model 的历史指纹（明确标注 stale）。
    const stale = findStaleFingerprint(env, target.model)
    if (stale !== null) {
      return valueOf(env, target, 'probe', {
        systemFingerprint: stale.fingerprint,
        modelEcho: stale.responseModel ?? stale.requestModel ?? target.model,
        traceId: stale.traceId ?? undefined,
        at: stale.at,
        stable: null,
        checks: null,
        cached: true,
        endpoint: null,
        confidence: 'low',
        confidenceNote: '探测失败，显示上次已知指纹（无法确认与当前会话同层）',
      }, { stale: true, staleReason: failure.message })
    }
    return { ok: false, error: failure, value: { supported: true, provider: target.provider, requestedModel: target.model, capture } }
  }
}

/**
 * 对外状态接口：所有响应统一带 `apiVersion`（只加字段；删改字段必须 bump 版本）。
 * 契约见 docs/INTERFACE.md。
 */
async function handleState (env, request) {
  const [result, alert] = await Promise.all([
    handleStateResult(env, request),
    readExternalAlert(env),
  ])
  return { apiVersion: API_VERSION, alert, ...result }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

/** 记录每次流式模型调用（解码前就在 llm/stream 处，先拿到 provider/model/sessionId）。 */
function installStreamRecorder (env) {
  return env.ctx.effect(() => env.ctx.on('llm/stream', (options, next) => {
    try {
      if (isObject(options)) {
        const now = Date.now()
        const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
        const record = {
          at: now,
          provider: typeof options.provider === 'string' ? options.provider : '',
          model: typeof options.model === 'string' ? options.model : '',
          reasoningEffort: options.reasoningEffort === undefined ? null : String(options.reasoningEffort),
          purpose: typeof options.purpose === 'string' ? options.purpose : null,
        }
        env.lastStreamCall = record
        if (sessionId !== undefined && sessionId.length > 0) {
          rememberBounded(env.lastCallBySession, sessionId, record, MAX_SESSION_RECORDS)
        }
        schedulePersist(env)
      }
    } catch {
      // 旁路记录失败不影响模型调用
    }
    return next()
  }), 'system-fingerprint: llm/stream recorder')
}

/** 注册 /api 状态路由；connection 形状不符时保持缺席而不是抛错。 */
function installStateRoute (env) {
  const ctx = env.ctx
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  const register = connection && connection.fetch && typeof connection.fetch.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) return
  ctx.effect(() => register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => Response.json(await handleState(env, request), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    }),
  }), `dsh-system-fingerprint: ${STATE_PATH}`)
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply (ctx, rawConfig) {
  const env = createEnv(ctx, rawConfig)
  // 只读配置导出：先同步写一份（配置立即可见），hydrate 出上次探测的 lastProbe 后再刷新。
  void persistConfigExport(env)
  void hydrateMeta(env).then(() => persistConfigExport(env))
  void hydrateEndpoints(env)
  ctx.effect(() => {
    const uninstall = installFetchCapture(env)
    return () => {
      uninstall()
      if (env.persistTimer !== undefined) {
        clearTimeout(env.persistTimer)
        env.persistTimer = undefined
      }
      void persistMeta(env)
      void persistEndpoints(env)
    }
  }, 'system-fingerprint: raw response interception')
  installStreamRecorder(env)
  installStateRoute(env)
}

/** 测试与排障用：暴露纯函数（不构成对外 API）。 */
export const _internals = {
  API_VERSION,
  ALERT_SCHEMA_VERSION,
  normalizeExternalAlert,
  readExternalAlert,
  CONFIG_EXPORT_FILE,
  CONFIG_EXPORT_VERSION,
  PLUGIN_VERSION,
  DEFAULT_CHECKPOINTS,
  DEFAULT_GATEWAY_HEADERS,
  DEFAULT_GATEWAY_SESSION_HEADER,
  configExportOf,
  persistConfigExport,
  STATE_PATH,
  classifyApiPath,
  extractFingerprint,
  extractGateway,
  extractResponseId,
  extractResponseModel,
  headersToObject,
  extractRequestHeaders,
  handleState,
  isGatewayEvidence,
  findRecordedGateway,
  gatewayFieldsOf,
  normalizeGatewayHeaders,
  normalizeGatewayHosts,
  normalizeGatewaySessionHeader,
  valueOfGateway,
  accumulateEndpoint,
  emptyEndpointRegistry,
  responseIdFamily,
  persistEndpoints,
  hydrateEndpoints,
  mapFingerprint,
  md5Hex,
  normalizeConfig,
  normalizeTable,
  probeCached,
  probeEndpointCandidates,
  probeOnce,
  probePaths,
  probeWithCandidates,
  deriveConversationBase,
  endpointConfidence,
  resolveTarget,
  captureSummaryOf,
  captureResponse,
  findRecordedFingerprint,
  findStaleFingerprint,
  captureTargetOf,
  createEnv,
  installFetchCapture,
  readRawBody,
  storagePaths,
}
