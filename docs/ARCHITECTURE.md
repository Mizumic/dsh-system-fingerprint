# 架构说明（内部实现）

> 这份文档解释**插件内部怎么工作**，面向维护者；对外稳定字段以
> [`INTERFACE.md`](INTERFACE.md) 为准。内部实现（`meta.json`、`raw/`、函数名）不承诺兼容。

## 1. 总览

插件由两半边组成，通过一个 HTTP 状态端点相连：

```
DSH Host（Node 进程）
├─ lib/index.js       宿主半边：fetch 拦截 + 主动探测 + /api/system-fingerprint/state
│                     产物：$DSH_HOME/storages/system-fingerprint/{meta.json, endpoints.json, config.json, raw/}
└─ /api 状态端点  ◀── 浏览器 fetch（cookie 鉴权）
                         │
浏览器（DSH Web GUI）      │
└─ lib/client.js      浏览器半边：会话头部徽标 + 悬浮卡 + 轮询/自动复检
```

* 宿主半边是 ESM 单文件、只 import Node 内建模块，因此可以用 `file://…?v=N` 热加载。
* 浏览器半边是 classic-script bundle，只通过模块表 `require('react/jsx-runtime')` 取运行时，
  不直接 import 任何 Harness 包。
* 插件是**被动层**：不包含任何主动监测项目（如 driftmon）的代码，只通过只读文件/可选告警输入交互。

## 2. 宿主半边

### 2.1 装配

`apply(ctx, config)` 依次：

1. `normalizeConfig` 归一化配置（端口/检查点表/网关头映射/隐私开关/告警文件），
   并把检查点表编译成 `Map<fingerprint, entry>`；
2. 安装 fetch 拦截（解码前 `clone()` 响应，解析元数据）；
3. 安装 `llm/stream` 旁路记录器（用于在没有真实响应证据时解析目标 provider/model/session）；
4. 注册 `GET /api/system-fingerprint/state`（`connection.fetch.register`，HTTP 一律 200，错误看 `ok`）；
5. 异步 hydrate：`meta.json` → 历史存证/会话端点记忆/上次探测；`endpoints.json` → 端点登记表；
   随后写一份 `config.json` 只读导出。

### 2.2 响应拦截与存证

`captureTargetOf` 只拦模型补全路径（`/chat/completions`、`/messages` 等，按宿主配置的 host 白名单）：

* 请求侧：记录 URL、同源根（`deriveConversationBase`）、模型、会话 id（Harness 头或网关会话头）、
  请求头（键名小写，凭据字段一律 `<redacted>`）；
* 响应侧：解析 `system_fingerprint`、回显 model、trace id、响应 id 形态、usage 形态、网关溯源头；
* 原始字节：**默认不落盘**（`captureRaw: false`）。元数据证据仍保留；打开 raw 后按
  `maxRawFiles × maxRawBytes` 滚动淘汰；
* 拦截结果写入 `meta.json`（内部产物）并更新 `endpoints.json`（契约）与
  「本会话真实请求同源根」记忆（`lastRequestBySession`），后者是同层探测的输入。

探针请求带 `x-dsh-system-fingerprint-probe: 1`，不会被当成真实对话证据。

### 2.3 主动探测

```
resolveTarget(query/session 投影/stream 记录/默认配置)
    ↓
probeEndpointCandidates
    observed（本会话真实请求同源根 + 会话头）
    observed-origin（同 origin 根，兼容网关不同前缀）
    config（配置 openaiBaseURL）
    env-default
    ↓ 依次尝试，端点 404/405/501 或网络错误才换下一个
probeOnce：POST <base>/chat/completions（或 /v1/chat/completions），max_tokens=1
    ↓
runProbe：按 stabilityChecks 采样 N 次（>1 时校验一致性）
    一致 → stable=true，variants=[单指纹]
    不一致 → 主指纹取多数；variants=[{fingerprint,count}...]（A/B 灰度）
```

### 2.4 同层可信度

`endpointConfidence` 对照「本会话真实请求的同源根」判定这次探测是否与对话同层：

| 条件 | confidence |
| --- | --- |
| 探测端点取自本会话同源根（`source: observed`） | `high` |
| 与对话同 host，但来自配置/同 origin 回退 | `medium` |
| 没有观测，或探测回退/失败 | `low` |

同一份探测结果里的 `confidence` 只在**探测开始那一刻**成立，随后可能过时（本会话真实请求晚到、
结果来自缓存、并发探测先完成）。因此宿主在**每次组装响应时**调用 `reassessProbe`：

* 用当前观测校正端点来源（同源根 → `observed`；会话端点变了 → 不再声称同源）；
* 重算 `confidence` / `confidenceNote`。

这样 `endpoint.source` 与 `confidence` 永远来自同一时刻的判断，缓存命中不会返回
「`observed` + `low`」的矛盾快照（这是 0.3.3 修掉的缺陷）。

### 2.5 探测缓存与并发

* 缓存键 = `model + baseURL + sessionId`，按「端点 + 会话」隔离，避免跨层复用到别的凭证/路由；
* 成功结果 TTL 60s，失败结果 TTL 10s；
* 同一键的并发取数共享一次 in-flight 探测（force 探测不加入、但会占用同一键，因此清理时只删
  自己登记的那次）；
* 写入缓存时按**探测开始时刻**排序：更旧的探测结果不能覆盖已有缓存——否则点击强制刷新得到的
  新结果会被晚到的慢探测写回旧值。

### 2.6 结果组装与状态端点

`valueOf` / `valueOfGateway` 把探测/证据组装成三种 `value` 形态（字段契约见
[`INTERFACE.md`](INTERFACE.md) §1）：

1. 指纹可用：映射命中 → 检查点名；未命中 → 原始 md5；
2. 网关溯源：上游不返回指纹但有网关证据 → 请求级溯源，`supported: false`；
3. 不可探测路由：`reason: provider-not-probeable`。

`alert` 字段合并可选外部告警文件（display-only，缺失/损坏静默降级）。
`apiVersion: 1` 始终存在；错误一律 `ok: false` + `error.code`。

### 2.7 持久化产物

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `meta.json` | 内部 | 最近存证、会话端点记忆、上次探测；字段可改 |
| `raw/` | 内部 | 原始响应字节（仅 `captureRaw: true`）；可安全删除 |
| `endpoints.json` | **契约 v1** | 网关端点登记表；原子写、只增不减、启动 hydrate 迁移旧假端点 |
| `config.json` | **契约 v1** | 只读配置导出（白名单、无凭据），含最近检查点绑定 |

## 3. 浏览器半边

* 槽位：`conversation.session.header.utilities`，id `system-fingerprint`，order `-5`。
* 取数：挂载时 + 每 10 分钟（页面可见时）+ 点击强制（`refresh=1`）。
* 自动复检：当结果是**探测来源**且 `confidence !== 'high'` 时，按 5s/10s/20s/40s/60s 最多再取 5 次；
  转 `high`、用户点击、次数用尽或页面隐藏都会停止。复检优先命中宿主 60s 缓存，开销可控。
* 徽标状态（圆点颜色由 `badgeOf` 决定）：

| 优先级 | 状态 | 圆点 |
| --- | --- | --- |
| 1 | 探测/接口错误 | 错误色 + 按错误码的短文案 |
| 2 | 网关溯源（不是指纹） | 品牌色 + 上游端点名 |
| 3 | 不可探测路由 | 中性色「不适用」 |
| 4 | 映射命中 + 非 A/B + `confidence=high` | 成功色 + 检查点名 |
| 5 | 其余（未收录 md5 / A/B / 非 high / 外部告警 warn-critical） | 警示色（告警时文案追加 `⚠`） |

* 悬浮卡：标签/值两列、长值换行；展示模型、检查点、指纹、明文、来源、探测端点、同层可信度、
  探测时间、最近真实响应时间差、稳定性、指纹变体、存证状态等。滚动/缩放自动收起。

## 4. 数据流（指纹模式）

```
真实对话请求 ──拦截──▶ 元数据 + 同源根记忆 ──▶ 探测候选端点（observed 优先）
                                    │
                                    ▼
                              POST /chat/completions × N
                                    │  system_fingerprint
                                    ▼
          映射表（检查点名 / 原始 md5）+ 采样一致性（stable / variants）
                                    │
                                    ▼
       同层可信度（endpointConfidence）+ 每次取数重算（reassessProbe）
                                    │
                                    ▼
                 /state ──▶ 徽标（颜色/文案/悬浮卡）
```

## 5. 不变量与边界

* 宿主半边单文件、无相对 import，只 import `node:*`；
* 浏览器半边不 import Harness 包，只走模块表；
* 插件代码零外部监测项目引用（测试断言）；
* 只写自己的存储目录；`config.json` 不含凭据、prompt、响应正文、绝对 `DSH_HOME` 路径；
* 隐私默认：元数据证据开、原始字节关；请求头中的凭据字段始终 `<redacted>`；
* 对外契约只加字段不改语义（见 `INTERFACE.md` §6）。

## 6. 扩展点

| 想做什么 | 改哪里 |
| --- | --- |
| 换供应商 / 加检查点 | 配置 `checkpointTable`（`{name, plaintext?}` 或 `{name, fingerprint}`） |
| 网关溯源字段不同 | 配置 `gatewayHeaders`（按语义角色覆盖 / 自定义键 / `false` 关闭） |
| 网关按会话头路由 | 配置 `gatewaySessionHeader` |
| 展示外部行为告警 | 配置 `externalAlertFile`（通用 v1 schema，只读） |
| 减少探测开销 | `stabilityChecks: 1`（放弃 A/B 识别）、调大 `cacheTtlMs` |
| 存证原始响应 | `captureRaw: true` + `maxRawBytes` / `maxRawFiles` |
