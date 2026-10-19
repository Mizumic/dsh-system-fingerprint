// dsh-system-fingerprint — 浏览器半边。
//
// 在会话头部右侧 utilities 槽位（标题栏右上、会话日志下载旁）挂一枚检查点徽标：
//   * 指纹命中内置映射表 → 显示检查点名（如「flash 1017」）；
//   * 映射表未收录 → 直接显示原始 32 位 system_fingerprint（md5）；
//   * 非 DeepSeek 官方路由 / 暂不可用 → 显示「不适用」/「指纹不可用」。
// 悬停（或键盘聚焦）弹出自定义卡片：标签/值两列、每条一行、长值换行，不用原生 title。
// 点击强制重新探测；页面可见时每 10 分钟轮询一次。
//
// 数据来自宿主半边的 GET /api/system-fingerprint/state（connection.fetch 注册的 /api 路由，
// 自带浏览器 cookie 鉴权）。本文件是手写 classic-script bundle：只从模块表 require react，
// 不 import 任何 Harness Client 包；样式只用 --dsw-alias-* 主题令牌。

window.__ModuleLoader__.load({
  id: 'dsh-system-fingerprint',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const { useCallback, useEffect, useRef, useState } = require('react')

    const NS = 'system-fingerprint'
    const SLOT = 'conversation.session.header.utilities'
    const ROUTE = '/api/system-fingerprint/state'
    const TOOLTIP_ID = 'dsh-system-fingerprint-tooltip'
    // 检查点轮换很慢（天级），探测又是真实计费请求：10 分钟一次足够。
    const POLL_MS = 10 * 60 * 1000

    const zh = {
      'badge.loading': '检查点…',
      'badge.unsupported': '不适用',
      'badge.gateway': '网关溯源',
      'badge.error': '指纹不可用',
      'badge.noCredential': '缺少凭据',
      'badge.unknownName': '映射表未收录',
      'badge.refreshing': '重新探测…',

      'label.status': '状态',
      'label.error': '错误',
      'label.model': '模型',
      'label.echo': '回显 model',
      'label.checkpoint': '检查点',
      'label.fingerprint': 'system_fingerprint',
      'label.plaintext': '检查点明文',
      'label.source': '指纹来源',
      'label.endpoint': '探测端点',
      'label.endpointConversation': '对话端点',
      'label.confidence': '同层可信度',
      'label.time': '探测时间',
      'label.correlate': '最近对话响应',
      'label.trace': 'x-ds-trace-id',
      'label.stable': '稳定性',
      'label.capture': '响应存证',
      'label.gatewayEndpoint': '后端池',
      'label.gatewayUpstream': '上游路由',
      'label.gatewayModel': '网关模型',
      'label.gatewayPlacement': '边缘落点',
      'label.gatewayRay': 'ray id',
      'label.gatewayLog': '请求日志 id',
      'label.gatewaySession': '网关会话头',
      'label.gatewayTrace': '网关溯源来源',
      'label.alert': '行为告警',
      'label.alertSignal': '告警通道',

      'value.observed': '取自本会话真实请求同源根',
      'value.observedOrigin': '同 origin 回退',
      'value.config': '配置项',
      'value.envDefault': '环境推导',
      'value.sameHost': '与对话同源',
      'value.diffHost': '与对话不同源',
      'value.headersForwarded': '已转发会话头（便于网关按会话路由）',
      'value.cached': '缓存',
      'value.probe': '主动探测',
      'value.response': '已拦截原始响应',
      'value.stable': '稳定（多次一致）',
      'value.unstable': '不稳定（多次不一致）',
      'value.single': '单次，未校验',
      'value.delta': '相差',

      'confidence.high': '高（取自本会话真实请求同源根）',
      'confidence.medium': '中（同 host，配置/同 origin 回退）',
      'confidence.low': '低（无观测或已回退配置端点）',

      'note.tableMiss': '映射表未收录该指纹，显示原始 md5。',
      'note.unsupported': '当前模型路由不在探测范围内（仅探测 DeepSeek 官方路由）。',
      'note.gatewayNotFingerprint': '这不是模型指纹：该上游不返回 system_fingerprint，以上是请求级的网关溯源。',
      'note.gatewayVolatile': '上游端点按会话绑定、到期重选：同一会话在一段时间内固定在某个上游，重选后会换；不同会话可能同时落在不同上游。不能用它判断模型版本。',
      'note.gatewaySessionLinked': '证据取自本会话真实响应头（解码前拦截）。',
      'note.gatewayModelLinked': '证据按 model + 时间窗匹配，未确认属于本会话。',
      'note.alertExternal': '告警来自外部只读文件（可选输入）：插件只展示，不判定、不依赖产出方。',
      'value.alertLevel.info': '提示',
      'value.alertLevel.warn': '警告',
      'value.alertLevel.critical': '严重',
      'note.stale': '探测失败，显示上次已知结果：',
      'note.probe': '探测得到的是当前后端配置指纹，不是历史响应指纹。',
      'note.response': '该指纹来自被拦截响应（解码前原始字节）里解析出的字段。',
      'note.forward': '若网关按会话/路径把对话转发到不同上游，外部探测无法替代服务端路由证据。',
      'note.captureSaved': '已保存 {n} 份 · 最新 {kind} {time}',
      'note.captureNone': '尚未拦截到原始响应',
      'note.captureDisabled': '响应拦截已关闭（capture: false）',
      'note.captureRawOff': '原始响应体不落盘（captureRaw 默认关，隐私优先）',
      'note.captureEvidenceOnly': '已拦截 {n} 份响应元数据（原始字节不落盘）',
      'note.captureTruncated': '（已截断）',
      'note.stabilitySingle': '稳定性未校验：当前只探测一次（stabilityChecks=1）。调到 2–3 会多次探测并比对，每次多一个探测请求。',
      'foot.refresh': '点击强制重新探测',
      'foot.refreshing': '正在重新探测…',
      'foot.done': '刚刚已重新探测',

      'error.missing-credential': '未找到 API 凭据（credentials 服务与环境变量均无）',
      'error.unauthorized': '凭据被上游拒绝',
      'error.rate-limited': '上游限流，请稍后再试',
      'error.server': '上游 5xx 错误',
      'error.timeout': '探测超时',
      'error.network': '网络不可达',
      'error.invalid-response': '探测响应不是合法 JSON',
      'error.missing-field': '探测响应缺少 system_fingerprint 字段',
      'error.bad-request': '请求参数有误',
      'error.http-client': '探测请求被上游拒绝',
      'error.internal': '插件内部错误',
      'error.network-client': '浏览器请求宿主端点失败',
    }

    const en = {
      'badge.loading': 'Checkpoint…',
      'badge.unsupported': 'N/A',
      'badge.gateway': 'Gateway',
      'badge.error': 'Fingerprint unavailable',
      'badge.noCredential': 'No credential',
      'badge.unknownName': 'Unmapped',
      'badge.refreshing': 'Re-probing…',

      'label.status': 'Status',
      'label.error': 'Error',
      'label.model': 'Model',
      'label.echo': 'Echoed model',
      'label.checkpoint': 'Checkpoint',
      'label.fingerprint': 'system_fingerprint',
      'label.plaintext': 'Checkpoint plaintext',
      'label.source': 'Source',
      'label.endpoint': 'Probe endpoint',
      'label.endpointConversation': 'Conversation endpoint',
      'label.confidence': 'Same-layer confidence',
      'label.time': 'Probed at',
      'label.correlate': 'Latest response',
      'label.trace': 'x-ds-trace-id',
      'label.stable': 'Stability',
      'label.capture': 'Response capture',
      'label.gatewayEndpoint': 'Backend pool',
      'label.gatewayUpstream': 'Upstream route',
      'label.gatewayModel': 'Gateway model',
      'label.gatewayPlacement': 'Edge placement',
      'label.gatewayRay': 'ray id',
      'label.gatewayLog': 'Request log id',
      'label.gatewaySession': 'Gateway session header',
      'label.gatewayTrace': 'Provenance source',
      'label.alert': 'Behavior alert',
      'label.alertSignal': 'Alert channel',

      'value.observed': 'same-origin root of this session',
      'value.observedOrigin': 'same-origin fallback',
      'value.config': 'config value',
      'value.envDefault': 'env default',
      'value.sameHost': 'same host as conversation',
      'value.diffHost': 'different host from conversation',
      'value.headersForwarded': 'session headers forwarded (gateway routing)',
      'value.cached': 'cached',
      'value.probe': 'live probe',
      'value.response': 'intercepted raw response',
      'value.stable': 'stable (checks agree)',
      'value.unstable': 'unstable (checks differ)',
      'value.single': 'single, not cross-checked',
      'value.delta': 'delta',

      'confidence.high': 'high (same-origin root of this session)',
      'confidence.medium': 'medium (same host, config/origin fallback)',
      'confidence.low': 'low (no observation, or config fallback)',

      'note.tableMiss': 'Fingerprint not in the mapping table; showing the raw md5.',
      'note.unsupported': 'This model route is outside the probe scope (DeepSeek official routes only).',
      'note.gatewayNotFingerprint': 'This is not a model fingerprint: the upstream returns no system_fingerprint; the values above are request-level gateway provenance.',
      'note.gatewayVolatile': 'The upstream endpoint is bound per session and re-picked when it expires: one session stays on one upstream for a while, then may move; different sessions can sit on different upstreams at the same time. It cannot identify the model version.',
      'note.gatewaySessionLinked': 'Taken from this session’s real response headers (intercepted before decoding).',
      'note.gatewayModelLinked': 'Matched by model + time window; not confirmed to belong to this session.',
      'note.alertExternal': 'Alert comes from an external read-only file (optional input): this plugin only displays it and does not produce or depend on it.',
      'value.alertLevel.info': 'info',
      'value.alertLevel.warn': 'warning',
      'value.alertLevel.critical': 'critical',
      'note.stale': 'Probe failed; showing the last known result: ',
      'note.probe': 'This is the current backend-config fingerprint, not a historical response fingerprint.',
      'note.response': 'Parsed from an intercepted response before decoding.',
      'note.forward': 'If a gateway forwards each conversation to a different upstream, no external probe substitutes for server-side routing evidence.',
      'note.captureSaved': 'saved {n} · latest {kind} {time}',
      'note.captureNone': 'No raw response captured yet',
      'note.captureDisabled': 'Response interception disabled (capture: false)',
      'note.captureRawOff': 'Raw response bodies are not persisted (captureRaw: false — privacy default)',
      'note.captureEvidenceOnly': 'Intercepted {n} response metadata record(s); raw bytes not persisted',
      'note.captureTruncated': ' (truncated)',
      'note.stabilitySingle': 'Stability not cross-checked: a single probe (stabilityChecks=1). Set it to 2–3 to repeat and compare (one extra probe request each).',
      'foot.refresh': 'Click to force a fresh probe',
      'foot.refreshing': 'Re-probing…',
      'foot.done': 'Re-probe finished',

      'error.missing-credential': 'No API credential found (credentials service and environment are both empty)',
      'error.unauthorized': 'The upstream rejected the credential',
      'error.rate-limited': 'Upstream rate limit; try again later',
      'error.server': 'Upstream 5xx error',
      'error.timeout': 'Probe timed out',
      'error.network': 'Network unreachable',
      'error.invalid-response': 'Probe response was not valid JSON',
      'error.missing-field': 'Probe response had no system_fingerprint field',
      'error.bad-request': 'Bad request parameters',
      'error.http-client': 'The upstream rejected the probe request',
      'error.internal': 'Plugin internal error',
      'error.network-client': 'Browser request to the host endpoint failed',
    }

    // ── 样式（只用主题令牌） ────────────────────────────────────────────────
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 24,
      padding: '0 9px',
      borderRadius: 999,
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: '16px',
      fontWeight: 500,
      cursor: 'pointer',
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: 320,
      whiteSpace: 'nowrap',
      userSelect: 'none',
      boxSizing: 'border-box',
    }

    const dotStyle = (color) => ({
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: color,
      flex: 'none',
    })

    const labelStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0,
    }

    const monoStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      letterSpacing: 0.2,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0,
    }

    const SPIN_KEYFRAMES = '@keyframes dsh-fp-spin{to{transform:rotate(360deg)}}'

    const spinnerStyle = {
      width: 10,
      height: 10,
      flex: 'none',
      borderRadius: '50%',
      border: '1.5px solid var(--dsw-alias-border-l2)',
      borderTopColor: 'var(--dsw-alias-brand-primary)',
      animation: 'dsh-fp-spin 0.7s linear infinite',
      boxSizing: 'border-box',
    }

    const DOT = {
      loading: 'var(--dsw-alias-state-idle-primary)',
      known: 'var(--dsw-alias-state-success-primary)',
      unknown: 'var(--dsw-alias-state-warn-primary)',
      gateway: 'var(--dsw-alias-brand-primary)',
      unsupported: 'var(--dsw-alias-state-idle-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    // 自定义悬浮卡片：标签列固定宽度，值列换行。原生 title 会把长内容摊成一条，故不用。
    const PANEL_STYLE = {
      position: 'fixed',
      zIndex: 1000,
      width: 340,
      maxWidth: 'calc(100vw - 24px)',
      padding: '10px 12px',
      borderRadius: 10,
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      textAlign: 'left',
      whiteSpace: 'normal',
      overflowY: 'auto',
      pointerEvents: 'none',
      boxSizing: 'border-box',
    }

    const rowStyle = {
      display: 'grid',
      gridTemplateColumns: '92px minmax(0, 1fr)',
      columnGap: 8,
      alignItems: 'start',
    }

    const rowLabelStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    }

    const rowValueStyle = {
      minWidth: 0,
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    }

    const monoValueStyle = {
      minWidth: 0,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      lineHeight: '17px',
      overflowWrap: 'anywhere',
      wordBreak: 'break-all',
    }

    const noteStyle = {
      marginTop: 6,
      paddingTop: 6,
      borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '16px',
      overflowWrap: 'anywhere',
    }

    const footStyle = {
      marginTop: 6,
      paddingTop: 6,
      borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '16px',
      opacity: 0.8,
    }

    const pad = (n) => String(n).padStart(2, '0')

    function formatTime (timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      const date = new Date(timestamp)
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function formatAge (ageMs) {
      if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return '—'
      const seconds = Math.floor(ageMs / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.floor(hours / 24)}d`
    }

    function errorText (t, code) {
      const key = `error.${code}`
      const localized = t(key)
      return localized === key ? t('error.internal') : localized
    }

    function captureText (t, capture) {
      if (!capture || capture.enabled !== true) return t('note.captureDisabled')
      // 拦截开启但原始字节不落盘（captureRaw 默认关）：仍算「拦截到元数据」，
      // 只是磁盘上没有模型正文——隐私默认要说清楚，别让人以为存证挂了。
      if (capture.rawEnabled !== true) {
        const total = Number.isFinite(capture.total) ? capture.total : 0
        return total > 0
          ? t('note.captureEvidenceOnly').replace('{n}', String(total))
          : t('note.captureRawOff')
      }
      const last = capture.last
      if (!last) return t('note.captureNone')
      const kind = last.kind === 'messages'
        ? 'Messages SSE'
        : last.kind === 'chat' ? 'chat.completions' : String(last.kind)
      const base = t('note.captureSaved')
        .replace('{n}', String(capture.total))
        .replace('{kind}', kind)
        .replace('{time}', formatTime(last.at))
      return `${base}${last.truncated === true ? t('note.captureTruncated') : ''}`
    }

    /** 悬浮卡片要展示的结构化内容：rows = 两列行，notes = 换行说明，footer = 底部提示。 */
    function buildPanelContentBase (t, snapshot) {
      const rows = []
      const notes = []
      const footer = snapshot.refreshing === true
        ? t('foot.refreshing')
        : snapshot.justRefreshed === true ? t('foot.done') : t('foot.refresh')

      if (snapshot.kind === 'loading') {
        rows.push({ label: t('label.status'), value: t('badge.loading') })
        return { rows, notes, footer: '' }
      }

      if (snapshot.kind === 'error') {
        const code = snapshot.error && snapshot.error.code ? String(snapshot.error.code) : 'internal'
        rows.push({ label: t('label.error'), value: errorText(t, code) })
        if (snapshot.error && snapshot.error.message) notes.push(String(snapshot.error.message))
        return { rows, notes, footer }
      }

      const value = snapshot.value
      if (!value) {
        rows.push({ label: t('label.status'), value: t('badge.error') })
        return { rows, notes, footer }
      }

      // 网关溯源模式：上游不发布 system_fingerprint，用实测到的请求级溯源头替代。
      // 文案必须把「这不是模型指纹」放在显眼位置，否则很容易被当成检查点读。
      if (value.displayKind === 'gateway' && value.gateway) {
        const gateway = value.gateway
        rows.push({ label: t('label.model'), value: `${value.provider ?? '—'} / ${value.requestedModel ?? '—'}` })
        // 溯源字段由宿主按配置顺序给出（gateway.fields），供应商无关：已知角色用词典标签，
        // 自定义角色用宿主给的键名/标签，老存证没有 fields 时回退到平铺的已知角色。
        const KNOWN_FIELD_LABELS = {
          endpointId: 'label.gatewayEndpoint',
          upstreamModelId: 'label.gatewayUpstream',
          zenModel: 'label.gatewayModel',
          logId: 'label.gatewayLog',
          placement: 'label.gatewayPlacement',
          rayId: 'label.gatewayRay',
        }
        const gatewayFields = Array.isArray(gateway.fields) && gateway.fields.length > 0
          ? gateway.fields
          : ['endpointId', 'upstreamModelId', 'zenModel', 'logId', 'placement', 'rayId']
            .filter((key) => typeof gateway[key] === 'string' && gateway[key].length > 0)
            .map((key) => ({ key, value: gateway[key] }))
        for (const field of gatewayFields) {
          if (!field || typeof field.value !== 'string' || field.value.length === 0) continue
          const labelKey = KNOWN_FIELD_LABELS[field.key]
          const label = typeof field.label === 'string' && field.label.length > 0
            ? field.label
            : labelKey !== undefined ? t(labelKey) : String(field.key)
          rows.push({ label, value: field.value, mono: field.key === 'logId' })
        }
        if (value.endpoint && value.endpoint.host) {
          rows.push({ label: t('label.endpointConversation'), value: String(value.endpoint.host) })
        }
        rows.push({
          label: t('label.gatewayTrace'),
          value: gateway.matchedBy === 'session'
            ? t('note.gatewaySessionLinked')
            : t('note.gatewayModelLinked'),
        })
        if (gateway.sessionId) {
          rows.push({
            label: t('label.gatewaySession'),
            value: `${String(gateway.sessionId)}（${gateway.sessionIdSource ?? '—'}）`,
            mono: true,
          })
        }
        if (value.confidence) {
          const confidenceKey = `confidence.${value.confidence}`
          const confidenceLabel = t(confidenceKey)
          rows.push({
            label: t('label.confidence'),
            value: confidenceLabel === confidenceKey ? String(value.confidence) : confidenceLabel,
          })
        }
        rows.push({ label: t('label.time'), value: `${formatTime(value.probedAt)}（${formatAge(value.ageMs)}）` })
        if (value.capture) rows.push({ label: t('label.capture'), value: captureText(t, value.capture) })
        notes.push(t('note.gatewayNotFingerprint'))
        notes.push(t('note.gatewayVolatile'))
        if (value.confidenceNote) notes.push(String(value.confidenceNote))
        if (value.note) notes.push(String(value.note))
        return { rows, notes, footer }
      }

      if (value.supported === false) {
        rows.push({ label: t('label.model'), value: `${value.provider ?? '—'} / ${value.requestedModel ?? '—'}` })
        notes.push(t('note.unsupported'))
        if (value.note) notes.push(String(value.note))
        return { rows, notes, footer }
      }

      if (typeof value.systemFingerprint !== 'string' || value.systemFingerprint.length === 0) {
        rows.push({ label: t('label.status'), value: t('badge.error') })
        return { rows, notes, footer }
      }

      const known = value.displayKind === 'checkpoint'
      rows.push({ label: t('label.model'), value: `${value.provider ?? '—'} / ${value.requestedModel ?? '—'}` })
      if (value.model && value.model !== value.requestedModel) {
        rows.push({ label: t('label.echo'), value: String(value.model) })
      }
      rows.push({ label: t('label.checkpoint'), value: known ? String(value.display) : t('badge.unknownName') })
      rows.push({ label: t('label.fingerprint'), value: value.systemFingerprint, mono: true })
      if (value.checkpoint && value.checkpoint.plaintext) {
        rows.push({ label: t('label.plaintext'), value: String(value.checkpoint.plaintext), mono: true })
      }
      const sourceLabel = value.fingerprintSource === 'response' ? t('value.response') : t('value.probe')
      rows.push({ label: t('label.source'), value: value.cached === true ? `${sourceLabel}（${t('value.cached')}）` : sourceLabel })

      if (value.endpoint && value.endpoint.host) {
        const endpointSource = value.endpoint.source === 'observed'
          ? t('value.observed')
          : value.endpoint.source === 'observed-origin'
            ? t('value.observedOrigin')
            : value.endpoint.source === 'env-default' ? t('value.envDefault') : t('value.config')
        rows.push({ label: t('label.endpoint'), value: `${value.endpoint.host}（${endpointSource}）` })
        if (value.endpoint.conversationHost) {
          const sameHost = value.endpoint.conversationHost === value.endpoint.host
          rows.push({
            label: t('label.endpointConversation'),
            value: `${value.endpoint.conversationHost}（${sameHost ? t('value.sameHost') : t('value.diffHost')}）`,
          })
        }
      }
      if (value.confidence) {
        const confidenceKey = `confidence.${value.confidence}`
        const confidenceLabel = t(confidenceKey)
        rows.push({
          label: t('label.confidence'),
          value: confidenceLabel === confidenceKey ? String(value.confidence) : confidenceLabel,
        })
      }
      rows.push({ label: t('label.time'), value: `${formatTime(value.probedAt)}（${formatAge(value.ageMs)}）` })

      const evidence = value.capture && value.capture.last ? value.capture.last : null
      if (evidence && evidence.kind === 'messages' && typeof evidence.at === 'number' && typeof value.probedAt === 'number') {
        rows.push({
          label: t('label.correlate'),
          value: `${formatTime(evidence.at)}（${t('value.delta')} ${formatAge(Math.abs(value.probedAt - evidence.at))}）`,
        })
      }
      if (value.traceId) rows.push({ label: t('label.trace'), value: String(value.traceId), mono: true })
      rows.push({
        label: t('label.stable'),
        value: value.stable === true
          ? t('value.stable')
          : value.stable === false ? t('value.unstable') : t('value.single'),
      })
      if (value.stable === null) notes.push(t('note.stabilitySingle'))
      if (value.capture) rows.push({ label: t('label.capture'), value: captureText(t, value.capture) })

      if (!known) notes.push(t('note.tableMiss'))
      if (value.confidenceNote) notes.push(String(value.confidenceNote))
      if (value.endpoint && value.endpoint.sessionHeaderForwarded === true) notes.push(t('value.headersForwarded'))
      if (value.stale === true) notes.push(`${t('note.stale')}${value.staleReason ?? ''}`)
      notes.push(value.fingerprintSource === 'response' ? t('note.response') : t('note.probe'))
      notes.push(t('note.forward'))
      return { rows, notes, footer }
    }

    /**
     * 把可选的外部行为告警（display-only）合并进卡片：warn/critical/info 都展示，
     * ok 不展示；只展示 changed 的信号行，避免把模板详情整段搬进来。
     */
    function appendAlertRows (t, snapshot, content) {
      const alert = snapshot === null || snapshot === undefined ? undefined : snapshot.alert
      if (!alert || typeof alert !== 'object') return
      if (alert.level === 'ok' || alert.level === undefined) return
      const levelKey = `value.alertLevel.${alert.level}`
      const levelText = t(levelKey) === levelKey ? String(alert.level) : t(levelKey)
      content.rows.push({
        label: t('label.alert'),
        value: `${levelText} · ${String(alert.message || alert.verdict || '')}`,
      })
      const changed = (Array.isArray(alert.signals) ? alert.signals : []).filter((signal) => signal && signal.verdict === 'changed')
      for (const signal of changed.slice(0, 3)) {
        content.rows.push({
          label: `${t('label.alertSignal')} · ${String(signal.channel ?? '')}`,
          value: String(signal.detail || signal.verdict || ''),
        })
      }
      content.notes.push(t('note.alertExternal'))
      for (const caveat of (Array.isArray(alert.caveats) ? alert.caveats : []).slice(0, 3)) {
        if (typeof caveat === 'string' && caveat.length > 0) content.notes.push(caveat)
      }
    }

    function buildPanelContent (t, snapshot) {
      const content = buildPanelContentBase(t, snapshot)
      appendAlertRows(t, snapshot, content)
      return content
    }

    /**
     * 徽标文案。网关模式直接显示**上游端点名**（如 `manhattan-project`）——比「网关溯源」四个字
     * 信息量大得多；语义澄清（这不是模型指纹、会整段切换）放在悬浮卡片里。
     * 端点名取不到时才回退到通用标签。
     */
    function badgeOfBase (t, snapshot) {
      if (snapshot.kind === 'error') {
        const code = snapshot.error && snapshot.error.code ? String(snapshot.error.code) : 'internal'
        return { tone: 'error', text: code === 'missing-credential' ? t('badge.noCredential') : t('badge.error'), mono: false }
      }
      if (snapshot.kind === 'value') {
        const value = snapshot.value
        if (value && value.displayKind === 'gateway' && value.gateway) {
          // 主显示由宿主按配置的溯源字段顺序给出；老版本/老存证回退到 endpointId → zenModel。
          const primary = typeof value.display === 'string' && value.display.length > 0
            ? value.display
            : typeof value.gateway.endpointId === 'string' && value.gateway.endpointId.length > 0
              ? value.gateway.endpointId
              : typeof value.gateway.zenModel === 'string' ? value.gateway.zenModel : undefined
          return typeof primary === 'string' && primary.length > 0
            ? { tone: 'gateway', text: primary, mono: true }
            : { tone: 'gateway', text: t('badge.gateway'), mono: false }
        }
        if (!value || value.supported === false) return { tone: 'unsupported', text: t('badge.unsupported'), mono: false }
        if (typeof value.systemFingerprint === 'string' && value.systemFingerprint.length > 0) {
          const known = value.displayKind === 'checkpoint'
          // 映射正确 ≠ 确认当前对话就是这层后端：可信度不是 high 时用警示色。
          return {
            tone: known && value.confidence === 'high' ? 'known' : 'unknown',
            text: known ? String(value.display) : value.systemFingerprint,
            mono: !known,
          }
        }
        return { tone: 'error', text: t('badge.error'), mono: false }
      }
      return { tone: 'loading', text: t('badge.loading'), mono: false }
    }

    /**
     * 徽标文案（含可选告警合并）：warn → 警示色 + 「⚠」；critical → 错误色 + 「⚠」。
     * 文案主体仍是指纹/检查点/网关端点，告警只是附加标记，详情在悬浮卡片里。
     */
    function badgeOf (t, snapshot) {
      const badge = badgeOfBase(t, snapshot)
      const alert = snapshot === null || snapshot === undefined ? undefined : snapshot.alert
      if (!alert || typeof alert !== 'object') return badge
      if (alert.level !== 'warn' && alert.level !== 'critical') return badge
      return {
        tone: alert.level === 'critical' ? 'error' : 'unknown',
        text: `${badge.text} ⚠`,
        mono: badge.mono,
      }
    }

    /** fixed 定位：贴着徽标下方；下方空间不够就翻到上方。 */
    function panelPlacement (rect) {
      const margin = 8
      const width = Math.min(340, window.innerWidth - margin * 2)
      const right = Math.max(margin, Math.min(window.innerWidth - rect.right, window.innerWidth - width - margin))
      const below = window.innerHeight - rect.bottom - margin - 6
      const above = rect.top - margin - 6
      const showBelow = below >= 200 || below >= above
      const maxHeight = Math.max(120, Math.min(520, showBelow ? below : above))
      return {
        width,
        right,
        maxHeight,
        ...(showBelow
          ? { top: Math.round(rect.bottom + 6) }
          : { bottom: Math.round(window.innerHeight - rect.top + 6) }),
      }
    }

    /**
     * 会话头部检查点徽标。
     * @param {object} props - 槽位标准 props（含 sessionId / useProjection）与 locale 注入的 t。
     */
    function SystemFingerprintBadge (props) {
      const { sessionId, useProjection, t } = props
      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
      const selection = projection ? (projection.next ?? projection.lastUsed) : undefined
      const provider = selection && typeof selection.provider === 'string' ? selection.provider : undefined
      const model = selection && typeof selection.model === 'string' ? selection.model : undefined

      const [snapshot, setSnapshot] = useState({ kind: 'loading', alert: null, refreshing: false })
      const [placement, setPlacement] = useState(null)
      const requestSeq = useRef(0)
      const hideTimer = useRef(0)
      const refreshFlashTimer = useRef(0)

      const load = useCallback(async (force) => {
        const seq = requestSeq.current + 1
        requestSeq.current = seq
        const startedAt = Date.now()
        if (force) setSnapshot((previous) => ({ ...previous, refreshing: true }))
        let next
        try {
          const url = new URL(ROUTE, window.location.origin)
          if (sessionId !== undefined && sessionId !== null && String(sessionId).length > 0) {
            url.searchParams.set('sessionId', String(sessionId))
          }
          if (provider !== undefined) url.searchParams.set('provider', provider)
          if (model !== undefined) url.searchParams.set('model', model)
          if (force) url.searchParams.set('refresh', '1')
          const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`host endpoint responded ${response.status}`)
          const body = await response.json()
          if (body && body.ok === true && body.value) {
            next = { kind: 'value', value: body.value, alert: body.alert ?? null, refreshing: false }
          } else {
            next = {
              kind: 'error',
              error: (body && body.error) || { code: 'internal', message: 'empty response' },
              alert: (body && body.alert) ?? null,
              refreshing: false,
            }
          }
        } catch (error) {
          next = {
            kind: 'error',
            error: {
              code: 'network-client',
              message: error instanceof Error ? error.message : String(error),
            },
            refreshing: false,
          }
        }
        if (requestSeq.current !== seq) return
        if (force) {
          // 探测很快（通常几百毫秒）：保证「重新探测」反馈至少可见一小段时间，否则像没反应。
          const remaining = 650 - (Date.now() - startedAt)
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
          if (requestSeq.current !== seq) return
          next.justRefreshed = true
        }
        setSnapshot(next)
        if (force) {
          if (refreshFlashTimer.current !== 0) window.clearTimeout(refreshFlashTimer.current)
          refreshFlashTimer.current = window.setTimeout(() => {
            refreshFlashTimer.current = 0
            setSnapshot((previous) => (previous.justRefreshed === true ? { ...previous, justRefreshed: false } : previous))
          }, 1800)
        }
      }, [sessionId, provider, model])

      useEffect(() => {
        void load(false)
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') void load(false)
        }, POLL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
          if (hideTimer.current !== 0) window.clearTimeout(hideTimer.current)
          if (refreshFlashTimer.current !== 0) window.clearTimeout(refreshFlashTimer.current)
        }
      }, [load])

      // 卡片打开期间窗口滚动/缩放会错位：直接收起。
      useEffect(() => {
        if (placement === null) return undefined
        const close = () => setPlacement(null)
        window.addEventListener('resize', close)
        window.addEventListener('scroll', close, true)
        return () => {
          window.removeEventListener('resize', close)
          window.removeEventListener('scroll', close, true)
        }
      }, [placement])

      const openPanel = (event) => {
        if (hideTimer.current !== 0) {
          window.clearTimeout(hideTimer.current)
          hideTimer.current = 0
        }
        setPlacement(panelPlacement(event.currentTarget.getBoundingClientRect()))
      }
      const closePanelSoon = () => {
        if (hideTimer.current !== 0) window.clearTimeout(hideTimer.current)
        hideTimer.current = window.setTimeout(() => {
          hideTimer.current = 0
          setPlacement(null)
        }, 80)
      }

      const content = buildPanelContent(t, snapshot)
      // 注意：refreshing 时下面要改写这两个值（点击「强制重新探测」期间显示转圈 + 文案），
      // 必须用 let；写成 const 会在渲染时抛 TypeError，被槽位错误边界摘除条目 → 徽标消失。
      let { tone, text, mono } = badgeOf(t, snapshot)

      const refreshing = snapshot.refreshing === true
      if (refreshing) {
        text = t('badge.refreshing')
        mono = false
      }

      const panel = placement === null ? null : jsxs('div', {
        id: TOOLTIP_ID,
        role: 'tooltip',
        style: { ...PANEL_STYLE, ...placement },
        children: [
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 4 },
            children: content.rows.map((row, index) => jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: rowLabelStyle, children: row.label }),
                jsx('span', { style: row.mono === true ? monoValueStyle : rowValueStyle, children: row.value }),
              ],
            }, `row-${index}`)),
          }),
          content.notes.length === 0 ? null : jsx('div', {
            style: noteStyle,
            children: content.notes.map((note, index) => jsx('div', {
              style: index === 0 ? undefined : { marginTop: 4 },
              children: note,
            }, `note-${index}`)),
          }),
          content.footer ? jsx('div', { style: footStyle, children: content.footer }) : null,
        ].filter((node) => node !== null),
      })

      const badge = jsxs('button', {
        type: 'button',
        style: {
          ...badgeStyle,
          ...(refreshing ? { opacity: 0.9, cursor: 'progress' } : {}),
        },
        'aria-label': text,
        'aria-describedby': placement === null ? undefined : TOOLTIP_ID,
        'aria-busy': snapshot.kind === 'loading' || snapshot.refreshing === true,
        onMouseEnter: openPanel,
        onMouseLeave: closePanelSoon,
        onFocus: openPanel,
        onBlur: closePanelSoon,
        onClick: () => { void load(true) },
        children: [
          refreshing
            ? jsx('span', { style: spinnerStyle, 'aria-hidden': true })
            : jsx('span', { style: dotStyle(DOT[tone] ?? DOT.loading), 'aria-hidden': true }),
          jsx('span', { style: mono ? monoStyle : labelStyle, children: text }),
        ],
      })

      return jsx(Fragment, { children: [
        jsx('style', { dangerouslySetInnerHTML: { __html: SPIN_KEYFRAMES } }),
        badge,
        panel,
      ] })
    }

    // ── 插件接线 ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale']

    function apply (ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'system-fingerprint: dictionaries',
      )
      ctx.slots.inject(SLOT, () => ctx.slots.register(
        {
          name: SLOT,
          id: 'system-fingerprint',
          order: -5,
          locale: NS,
        },
        SystemFingerprintBadge,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    /** 测试与排障用：暴露纯函数（不构成对外 API）。 */
    exports.__internals = { buildPanelContent, badgeOf, dictionaries: { zh, en } }
    return module.exports
  },
})
