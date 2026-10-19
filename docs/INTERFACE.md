# 对外接口契约（INTERFACE v1）

> 本文件定义 `dsh-system-fingerprint` 对**外部消费者**的稳定接口。
> 原则：**只加字段、不改语义**；删字段 / 改语义必须 bump 对应版本号并在
> [`ROADMAP.md`](../ROADMAP.md) 记录迁移说明。消费者遇到不认识的版本号应**告警但继续读已知字段**，
> 不得崩溃或阻断自身流程。
>
> 依赖方向是**单向**的：
>
> ```
> driftmon（主动监测）  ──只读──▶  dsh-system-fingerprint 的端点登记表 / 只读配置
> dsh-system-fingerprint ──不依赖──▶  driftmon（插件代码里零 driftmon 引用，有测试断言）
> 任意产出方（可选）    ──写──▶  外部告警文件 v1  ──只读展示──▶  插件徽标
> ```
>
> 外部告警文件是**可选输入**：插件不关心谁写、缺失/损坏/版本不认识都静默降级，不构成依赖。
>
> 插件是**被动层**：别人可以只装插件、不装 driftmon；反之 driftmon 也可在没有插件时工作
> （只是报告里少「端点是否已登记」「当前指纹」这类注释）。

## 0. 安装接线（bundle 契约）

| 项 | 值 | 说明 |
| --- | --- | --- |
| bundle patch | `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch`） | 插入宿主插件行，id = `system-fingerprint` |
| 宿主模块 | `lib/index.js` | ESM，`export function apply(ctx, config)` + `export const inject = ['connection']` |
| 浏览器模块 | `lib/client.js`（`dsh.client` → `./client`） | classic-script bundle，槽位 `conversation.session.header.utilities`，id `system-fingerprint`，order `-5` |
| 配置 | 插件行 `config`（见 README「配置」） | 全部可选，缺省值见 README |

安装/升级/卸载走 DSH 的 `plugin_manager`；宿主半边重新启用 bundle 即生效，浏览器半边需刷新页面。

## 1. HTTP 状态接口（v1）

```
GET /api/system-fingerprint/state?sessionId=<id>&provider=<id>&model=<id>&refresh=1
```

由宿主 `connection.fetch` 在 `/api` 围栏下注册：继承 Host/Origin 校验与浏览器 cookie 鉴权，
**HTTP 一律 200**，错误看响应体 `ok`。消费方：徽标 UI（第一方），其他页面/脚本（允许）。

**响应顶层**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `apiVersion` | `1` | 本接口契约版本（v1 起始终存在） |
| `ok` | boolean | 是否成功拿到结果 |
| `value` | object? | 成功/降级时的结果（见下） |
| `error` | `{code, message}`? | 失败时的机器可读错误码 + 人类可读说明 |
| `alert` | object? \| null | **可选外部行为告警**（display-only，见 §4）；未配置/无文件/损坏时为 `null` |

**错误码**：`missing-credential` / `unauthorized` / `rate-limited` / `server` / `timeout` /
`network` / `invalid-response` / `missing-field` / `bad-request` / `http-client` / `internal`。

**`value` 的三种形态**（用 `displayKind` / `supported` 区分）：

1. 指纹可用（检查点或未收录 md5）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `supported` | `true` | 指纹维度可用 |
| `displayKind` | `'checkpoint' \| 'fingerprint'` | 命中映射表 / 未收录显示原始 md5 |
| `display` | string | 徽标主文案（检查点名或 32 位 md5） |
| `systemFingerprint` | string | 32 位小写 hex |
| `fingerprintSource` | `'probe' \| 'response'` | 主动探测 / 本会话真实响应 |
| `checkpoint` | `{name, plaintext?} \| null` | 命中的映射表条目 |
| `provider` / `requestedModel` / `model` / `reasoningEffort` / `modelSource` | string? | 路由与解析来源 |
| `probedAt` / `ageMs` | number | 该指纹的采集时间与年龄 |
| `traceId` | string? | 请求级 trace（官方 `x-ds-trace-id`，网关 `x-opencode-log-id`） |
| `stable` / `checks` | boolean?/number? | 稳定性校验结果（`stabilityChecks>1` 时） |
| `cached` / `stale` / `staleReason` | boolean/string? | 缓存命中、失败时回退旧值 |
| `endpoint` | object? | `{baseURL, host, source: observed\|observed-origin\|config\|env-default, conversationHost, sessionHeaderForwarded, attempts}` |
| `confidence` | `'high' \| 'medium' \| 'low'` | 探测与对话同层可信度 |
| `confidenceNote` | string? | 可信度的人话解释 |
| `capture` | object | 见「capture 子对象」 |
| `tableSize` | number | 映射表行数 |
| `note` | string | 语义说明 |

2. 网关溯源（上游不返回 `system_fingerprint`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `supported` | `false` | **指纹维度不可用**（不是失败） |
| `reason` | `'gateway-provenance'` | |
| `displayKind` | `'gateway'` | |
| `display` | string | 配置里第一个有值的溯源字段（默认 = `endpointId` 后端池） |
| `fingerprint` | object | `{available:false, systemFingerprint:null, checkpoint:null, reason:'upstream-no-system-fingerprint'}` |
| `gateway.fields` | `[{key, value}]` | 按 `gatewayHeaders` 配置顺序的溯源字段（UI 直接渲染） |
| `gateway.endpointId` 等 | string? | 已知角色平铺（旧字段兼容）：`upstreamModelId` / `logId` / `zenModel` / `placement` / `rayId` |
| `gateway.matchedBy` | `'session' \| 'model'` | 会话关联 / model+时间窗兜底 |
| `gateway.sessionId` / `sessionIdSource` / `at` / `ageMs` / `requestPath` / `endpointHost` | | 归因证据 |
| `confidence` | `'high' \| 'medium'` | 按会话关联高度 / model 兜底 |
| `note` | string | 明确写出「这不是模型指纹」 |

3. 不在探测范围的路由（例如别的 provider 且无网关证据）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `supported` | `false` | |
| `reason` | `'provider-not-probeable'` | |
| `probeProvider` | string | 实际会做探测的路由 |
| `note` | string | 「仅对 X 路由做探测」 |

**`capture` 子对象**（三种形态都有）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 响应拦截（元数据证据）是否开启（`capture`） |
| `rawEnabled` | boolean | 原始字节是否落盘（`captureRaw`，分发默认 `false`） |
| `headersEnabled` | boolean | 头原文是否进存证（`captureHeaders`） |
| `total` / `sessionTotal` | number | 累计 / 本会话拦截条数 |
| `dir` | string? | raw 目录（仅 `rawEnabled`） |
| `muting` | `null \| 'capture-disabled' \| 'capture-raw-disabled'` | 为什么没落原始字节 |
| `last` | object? | 最近一条元数据摘要（`at/kind/origin/status/bytes/truncated/saved/hasFingerprint/traceId/rawFile`） |

## 2. 文件契约 `endpoints.json`（v1）

路径：`$DSH_HOME/storages/system-fingerprint/endpoints.json`（原子写；只增不减）。
消费方：driftmon（`src/plugin-dep.mjs` 只读；版本不认识只告警）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | `1` | 本文件契约版本 |
| `updatedAt` | number(ms) | 最后写入时间 |
| `note` | string | 用途说明（供人读，不可依赖内容） |
| `endpoints` | object | key = `endpointId`；没有 endpointId 角色时用配置里第一个溯源字段值，兜底 `(未命名端点)` |
| `endpoints[id].count` / `sources` / `firstSeenAt` / `lastSeenAt` | | 观测次数与来源分桶（`capture` / `probe`） |
| `endpoints[id].models[model]` | object | `{count, firstSeenAt, lastSeenAt, upstreamModelIds, idFamilies, contexts}` |
| `endpoints[id].lastContext` | object | `{at, sessionId, sessionIdSource, requestModel, responseModel, upstreamModelId, zenModel, logId, rayId, placement, fields:[{key,value}], idFamily, status, source}` |

`fields` 是 v1 内的**新增字段**（旧消费者忽略即可）：完整保留自定义 `gatewayHeaders` 角色。

## 3. 文件契约 `config.json`（v1）

路径：`$DSH_HOME/storages/system-fingerprint/config.json`（原子写；**只读导出，不含凭据**）。
消费方：driftmon / 外部脚本（可选）；用于把「行为模板」绑定到已知检查点、对齐探测路由。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | `1` | 本文件契约版本 |
| `updatedAt` | number(ms) | 导出时间 |
| `note` | string | 用途说明 |
| `plugin` | `{name, version, stateApiVersion}` | 插件身份与接口版本 |
| `probe` | object | `{provider, model, openaiBaseURL, apiKeyEnv, timeoutMs, cacheTtlMs, stabilityChecks}`；`apiKeyEnv` 是**名字**不是凭据值 |
| `capture` | object | `{enabled, rawEnabled, headersEnabled, hosts}` |
| `gateway` | object | `{enabled, hosts, sessionHeader, headers:[{key, header}]}` |
| `checkpoints` | `[{name, fingerprint}]` | 映射表（**不含 plaintext**） |
| `checkpoint` | object? | 最近一次成功探测：`{fingerprint, name, source, provider, model, probedAt, endpointHost, confidence}`；没有则 `null` |

**禁止项**：任何凭据值、prompt、响应正文、绝对 DSH_HOME 路径都不允许出现在此文件里
（有接口测试断言）。

## 4. 可选输入：外部告警文件（v1）

配置项 `externalAlertFile` 指向一个通用 JSON 告警文件（任意产出方写，例如 driftmon 的
`template check`）。插件**只读展示**：合并进徽标（warn/critical 时警示色 + `⚠`）与悬浮卡片
（告警行 + changed 信号行 + 说明）。文件缺失、JSON 损坏、`version` 不认识、`level` 非法时一律当
`null`，不抛错、不阻塞其它功能。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | `1` | 本输入契约版本（插件只接受 1） |
| `kind` | string? | 产出方自用（如 `behavior-watch`），插件不解释 |
| `level` | `'ok' \| 'info' \| 'warn' \| 'critical'` | 展示级别；`ok` 不展示，warn/critical 触发徽标警示 |
| `verdict` | string | 产出方判定（如 `gray-candidate` / `checkpoint-change`） |
| `updatedAt` | number? | 判定时间（毫秒） |
| `message` | string | 一句话说明 |
| `subject` | object? | `{provider, model, checkpoint:{name, fingerprint}}` |
| `signals` | array? | `[{channel, verdict, detail}]`；插件只展示 `verdict==='changed'` 的前 3 条 |
| `caveats` | string[]? | 结论的限制说明 |

配置示例（本机路径写进 profile patch，不要写进仓库模板）：

```yaml
- id: system-fingerprint
  config:
    externalAlertFile: /path/to/driftmon/results/watch/gray-watch.json
```

## 5. 不构成契约的内部产物

`meta.json`、`raw/`、以及 `Symbol.for(...)` 槽位是插件**内部**实现：
字段随时可改、不做兼容承诺。外部消费者不得依赖；需要证据请用上面的三个契约。

## 6. 版本与变更流程

* 契约版本是整数：`apiVersion`（HTTP）与文件/输入的 `version`（`endpoints.json` / `config.json` / 外部告警文件）。
* **允许**：加字段、加枚举值（消费者必须容忍未知字段）。
* **需要 bump**：删/改字段、改字段语义、改错误码含义、改文件路径。
* **需要同步**：`docs/INTERFACE.md`、README、契约测试（`test/fp-interface-test.mjs`）、
  driftmon 侧消费代码；bump 记录写进 [`ROADMAP.md`](../ROADMAP.md)。
* 外部告警文件是**输入**：产出方升级版本时插件只会显示旧版内容或静默忽略，不会崩；
  需要新字段展示时再升插件的输入版本。
* 回归入口：`npm test`（含接口契约测试与分发清单测试）。

## 7. 消费者清单

| 消费者 | 用哪一个 | 说明 |
| --- | --- | --- |
| 徽标 UI（`lib/client.js`） | HTTP v1 | 只读展示，不改宿主状态 |
| driftmon | `endpoints.json` v1（必需）、`config.json` v1（可选） | 单向只读；插件不感知 driftmon |
| 外部脚本 / 面板 | HTTP v1 或文件 v1 | 建议按版本号做告警降级 |
| 外部告警产出方（可选） | 外部告警文件 v1（**插件读**） | 插件只展示；不感知产出方，也不回报 |
