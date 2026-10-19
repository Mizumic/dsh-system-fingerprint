# dsh-system-fingerprint

> DSH（DeepSeek Harness）Web 插件：在会话头部显示**当前模型检查点徽标**。
> 主动探测 `system_fingerprint` 并映射成检查点名（未收录显示原始 md5）；上游不返回指纹时，
> 展示可配置的**网关请求级溯源**（后端池 / 上游路由 / 请求 id）；拦截模型响应元数据用于存证与
> 端点登记。**原始响应字节默认不落盘**（隐私优先）。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-218%20passing-brightgreen.svg)](#验证状态)

本仓库是**可分发型**独立仓库：不写本机绝对路径、无 `private`、
供应商相关映射全部可配置、隐私默认安全。分发计划与完成状态见 [`ROADMAP.md`](ROADMAP.md)；
对外契约（HTTP / 文件）见 [`docs/INTERFACE.md`](docs/INTERFACE.md)。

## 目录

- [它做什么](#它做什么)
- [环境要求](#环境要求)
- [安装（分发）](#安装分发)
- [隐私默认](#隐私默认)
- [配置](#配置)
- [对外接口（契约 v1）](#对外接口契约-v1)
- [存证目录与存储预算](#存证目录与存储预算)
- [同层探测与可信度](#同层探测与可信度)
- [网关溯源模式](#网关溯源模式上游不返回-system_fingerprint)
- [关于「响应拦截」](#关于响应拦截)
- [开销](#开销)
- [语义](#语义)
- [开发与测试](#开发与测试)
- [验证状态](#验证状态)
- [相关仓库](#相关仓库)
- [贡献](#贡献)
- [安全](#安全)
- [变更记录](#变更记录)
- [许可证](#许可证)

## 它做什么

```
会话模型路由（provider/model）
    ├─（主路）主动探测：POST <同层端点根>/chat/completions → response.system_fingerprint
    │        └─ 内置 MD5 映射表 → 检查点名
    └─（证据/兜底）fetch 拦截：模型响应解码前 clone 一份，解析元数据（默认不落原始字节）
             └─ 解析原始文本里的 system_fingerprint / model / x-ds-trace-id；同时记下真实对话请求的
                URL / host / 同源根，作为「同层探测」的端点来源
             └─ 上游不返回指纹时，解析响应头里的网关溯源头（后端池 / 上游路由 / 请求 id）
             └─ 显式 captureRaw: true 时才把原始字节写到 $DSH_HOME/storages/system-fingerprint/raw/
```

* **已知指纹**：徽标显示检查点名，例如 `flash 1017`。
* **映射表未收录**：直接显示原始 32 位 `system_fingerprint`（md5），不猜测、不冒充。
* **网关路由（上游不返回指纹）**：徽标**直接显示上游端点名**（如 `manhattan-project`、
  `orcarouter-dsv4.1flash`，等宽字体、品牌色圆点），悬浮卡给出后端池 / 上游路由 / 请求 id，
  并明确写出「这不是模型指纹」。取不到端点名时才回退到通用标签「网关溯源」。
* **网关路由但还没抓到真实响应**：显示 `不适用`（不做无意义探测）。
* **行为告警合并**：可选读取外部只读告警文件（`externalAlertFile`，例如行为监测工具的输出）。
  warn/critical 时徽标追加 `⚠` 并转警示色；悬浮卡片里多出「行为告警」与 changed 通道行。
  缺失/损坏静默降级——插件不依赖任何产出方。
* **同层可信度不是 high**：徽标圆点转警示色，悬浮卡说明原因（见「同层探测与可信度」）。
* **悬停**：自定义悬浮卡片（不是原生 title）——标签/值两列、每条信息一行、长值（指纹/明文/trace id）
  自动换行；依次展示模型、检查点、指纹、明文、来源、探测端点/对话端点、同层可信度、探测时间、
  最近真实对话响应与探测的时间差、trace id、稳定性、响应存证（元数据/原始字节各自开关状态）；
  说明文字单独成段。卡片在徽标下方展开，下方空间不足时翻到上方；滚动/缩放会自动收起。
* **点击刷新反馈**：点击后徽标圆点变成转圈 + 文字「重新探测…」；卡片底部依次显示
  「正在重新探测…」→「刚刚已重新探测」；结果返回很快时也会保证这段反馈至少可见约 0.65s，
  避免「点了像没反应」。
* **点击**：绕过缓存强制重新探测。
* **轮询**：页面可见时每 **10 分钟**一次（探测是真实计费请求，见「开销」）。

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `0.2.0-rc.2` 或更高 | 需要 bundle patch（`cordis.patch.yml`）与插件管理能力 |
| Node.js | `>= 20` | 插件宿主半边只用 Node 内建模块，无运行时依赖 |
| 模型端点 | 一个 OpenAI 兼容端点（可选） | 有 `system_fingerprint` 最好；没有则走网关溯源或显示「不适用」 |
| 凭据 | 环境变量或 DSH credentials ref（可选） | 例如 `DEEPSEEK_API_KEY`；**从不写进配置文件或仓库** |

插件是**被动层**：单独安装即可工作。可选的主动监测工具（driftmon）只读本插件产物，
不装也不影响插件功能（见「相关仓库」）。

## 安装（分发）

插件是一个 DSH bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
同时带浏览器半边（`dsh.client` → `lib/client.js`）。

```bash
# 1) 取得仓库（git clone 或下载 release 包）
git clone https://github.com/Mizumic/dsh-system-fingerprint.git

# 2) 在 DSH 里用插件管理器安装这个 bundle（绝对路径或 npm 包名均可）
#    plugin_manager install_bundle('/绝对路径/dsh-system-fingerprint')
#    或者在 profile 的 dsh.profile.bundles 里以 link: 引用本目录（开发时）。
```

装好后：

* 宿主半边立即生效（重新启用 bundle 即换新模块实例，无需重启 DSH）；
  **浏览器半边需要刷新页面**（clientModules 按文件元数据换 rev）。
* 会话头部右上角出现「检查点 / 网关溯源」徽标；没有凭据时显示「缺少凭据」。
* 卸载：从 profile 的 bundles 里去掉本包并刷新页面。

> 开发期热加载：宿主半边是**单文件、无相对 import**，可把 profile patch 里的 `name` 临时写成
> `file:///绝对路径/lib/index.js?v=N`，每次改完代码把 `N` 递增、重新启用 bundle 即可生效
> （仅开发用；发行版请用包名安装，仓库模板不写 `file://`）。
> 重新启用 bundle 等价于在插件页关→开；浏览器半边始终只需刷新页面。

## 隐私默认

默认值的取舍是**隐私优先**（2026-10 起的分发语义）：

| 开关 | 默认 | 含义 |
| --- | --- | --- |
| `capture` | **开** | 拦截模型响应、保留**元数据/响应头**（徽标网关溯源与端点登记表要用；不落模型正文） |
| `captureRaw` | **关** | 把解码前**原始字节**（含模型回复正文）写到 `$DSH_HOME/storages/system-fingerprint/raw/`，需要存证时显式打开 |
| `captureHeaders` | 开 | 请求/响应头原文进存证（凭据字段始终 `<redacted>`） |

边界重申：请求体只解析 `model` 一个字段，**不保存 prompt**；
`Authorization` / `Cookie` / `x-api-key` 等凭据头始终写成 `<redacted>`，从不落盘。
「默认 `captureRaw: false`」不等于「不保存证据」：元数据、指纹解析、网关证据、端点登记照常工作
（见「存证目录与存储预算」）。默认配置下 raw 目录 **0 个文件**，由测试断言锁定。

## 配置

可在 profile 的 `cordis.patch.yml` 覆盖本插件行的 `config`（本包 `cordis.patch.yml` 是模板）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek-official` | 只对该路由做探测 |
| `model` | `deepseek-flash` | 会话投影/拦截记录缺失时的兜底模型 |
| `openaiBaseURL` | `https://api.deepseek.com` | **回退**探测端点（真实请求同源根不可用时才用） |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | credentials ref；不存明文 |
| `timeoutMs` | `15000` | 单次探测超时 |
| `cacheTtlMs` | `60000` | 成功结果缓存（合并刷新/并发，不是轮询间隔） |
| `stabilityChecks` | `1` | >1 时同请求多次，结果写入 `stable` |
| `capture` | `true` | **响应拦截总开关**：拦截模型响应并保留元数据/响应头证据；关掉后徽标只剩主动探测 |
| `captureRaw` | **`false`** | **原始字节落盘开关**（原始体含模型正文；分发版默认关，存证场景显式打开） |
| `captureHeaders` | `true` | 是否连请求头/响应头原文一起存证（凭据字段始终 `<redacted>`，键名小写、值截断 512） |
| `captureHosts` | 自动 | 额外需要拦截的 host；带 DSH 会话头的 host 自动放行；`gatewayHosts` 无条件并入 |
| `gatewayHosts` | `[opencode.ai]` | 网关溯源要拦截的 host（网关路由不带 harness 会话头，必须显式列出） |
| `gatewayHeaders` | 默认 6 角色 | **网关溯源响应头映射**（供应商无关）：按语义角色部分覆盖，键名是角色之外的会作为附加行；`false` = 整体关闭网关溯源 |
| `gatewaySessionHeader` | `x-opencode-session` | 网关自己的会话头（harness 会话头缺席时用它关联响应）；`false` = 不关联 |
| `maxRawBytes` | `524288` | 单份原始响应最多保存字节数（超出截断；仅 `captureRaw: true` 时生效） |
| `maxRawFiles` | `120` | raw 目录保留文件上限（按时间淘汰旧文件；仅 `captureRaw: true` 时生效） |
| `checkpointTable` | 内置 4 行 | 可替换的映射表，条目形如 `{ name, plaintext?, fingerprint? }`；只给 `plaintext` 时插件自行算 md5。换供应商时把自己的指纹/明文填进来即可 |
| `externalAlertFile` | 空（不读） | 可选外部行为告警文件路径（通用 schema v1，只读展示）；缺失/损坏/版本不认识都静默降级 |

非 DeepSeek 路由的语义：主动探测只针对 `provider` 配置的那条路由；其它路由如果响应里**实际**
带 `system_fingerprint`，徽标照样优先采用实际响应；如果既不返回指纹、又没配网关溯源头，
就显示「不适用」——插件不会拿别的路由的检查点冒充。

映射表默认值（与文档一致，4/4 实测通过）：

| 检查点 | 明文 | fingerprint |
| --- | --- | --- |
| v4-pro | `fp_v4pro_20260812_prod0820_fp8_kvcache_20260402_fp` | `a307abda…` |
| v4f 0908（内测） | `fp_v41f_0908_prod0820_fp8_kvcache_20260402_fp` | `6d641ab0…` |
| flash 0910（统一版） | `fp_dsv41f_0910_prod0820_fp8_kvcache_20260402_fp` | `aeb56401…` |
| flash 1017 | `fp_dsv41f_1017_prod0820_fp8_kvcache_20260402_fp` | `e72d3c7f…` |

## 对外接口（契约 v1）

插件是**被动层**，对外只有三类稳定契约（字段表、版本策略、兼容规则见
[`docs/INTERFACE.md`](docs/INTERFACE.md)）：

| 契约 | 路径 / 形态 | 消费方 |
| --- | --- | --- |
| HTTP 状态接口 | `GET /api/system-fingerprint/state`，响应带 `apiVersion: 1` | 徽标 UI（第一方）；其他页面/脚本 |
| 端点登记表 | `$DSH_HOME/storages/system-fingerprint/endpoints.json`（v1，只增不减） | 主动监测工具（如 driftmon，只读） |
| 只读配置导出 | `$DSH_HOME/storages/system-fingerprint/config.json`（v1，白名单、无凭据） | 主动监测工具 / 外部脚本（可选） |
| 外部告警输入（可选） | `externalAlertFile` 指向的 JSON（v1，display-only） | 展示层读，产出方可任意 |

**单向依赖**：插件代码里零外部监测项目引用、只 import Node 内建模块、只写自己的存储目录
（`test/fp-interface-test.mjs` 断言）。所以只装插件、完全不装 driftmon 也完全可用。
`meta.json` / `raw/` 是内部产物，不属于对外契约。

宿主 `connection.fetch` 在 `/api` 围栏下注册状态端点：

```
GET /api/system-fingerprint/state?sessionId=…&provider=…&model=…&refresh=1
```

模型解析优先级：query > 会话 `modelSelection` 投影 > 已拦截的 `llm/stream` 调用 > 默认模型 > 配置。
响应顶层带 `apiVersion: 1`；`ok` 表示成功，错误码见 [`docs/INTERFACE.md`](docs/INTERFACE.md)。
返回体里 `endpoint` / `confidence` / `confidenceNote` 描述这次探测的端点层与可信度；
网关模式下 `gateway.fields` 是按配置顺序的溯源字段数组（UI 直接渲染），
已知角色同时平铺在 `gateway.endpointId` / `upstreamModelId` / `logId` / `zenModel` /
`placement` / `rayId` 上（对外脚本兼容）。

## 存证目录与存储预算

```
$DSH_HOME/storages/system-fingerprint/
├── meta.json          # 最近 40 条拦截元数据（真实请求 URL / 同源根 / trace id / 模型 / 网关溯源）+ 每会话最后记录（内部产物）
├── endpoints.json     # 路由端点登记表 v1（对外契约）
├── config.json        # 只读配置导出 v1（对外契约；无凭据；含最近探测到的 checkpoint）
└── raw/               # 仅 captureRaw: true 时存在：解码前原始响应字节（.sse / .json）
    ├── 20261017-142101-123-messages-<session尾号>.sse
    └── 20261017-142101-456-chat.json
```

**默认（`captureRaw: false`）不产生 `raw/`**：磁盘上只有元数据与端点登记，没有模型回复正文。
打开 `captureRaw` 后 raw 目录是**滚动窗口**（按文件名时间戳淘汰最旧），不会无限增长：

| 产物 | 上限机制 | 默认/典型体积 | 最坏 |
| --- | --- | --- | --- |
| `raw/` 原始字节（含回复正文） | `maxRawFiles` × `maxRawBytes`，滚动淘汰 | 默认 0 文件；打开后约 10–20 MB | 120 × 512 KiB ≈ 60 MiB |
| `meta.json` 响应元数据 | 最近 40 条记录（每条约 3 KB）+ 每会话最后记录上限 60 | ≈ 120 KB | ≈ 150 KB |
| `endpoints.json` 端点登记表 | 按端点/模型键累积，不按请求数增长 | 数 KB | 随新端点缓慢增长（KB 级） |
| `config.json` 只读导出 | 原子覆盖，单份 | ≈ 2 KB | ≈ 2 KB |

说明：

* `raw/` 里是解码前**原始响应**（模型正文），所以默认关；需要离线证据/排查响应格式时再开。
* 淘汰最多每 5 秒执行一次，因此瞬时可能看到 `maxRawFiles + 少量` 个文件，属正常。
* 删除 `raw/` 文件是安全的：它只是离线证据，清理不影响徽标、探测和对外契约文件。
* `endpoints.json` 的字段（只增不减，外部脚本可依赖）：

```jsonc
{
  "version": 1, "updatedAt": 1792…, "note": "…",
  "endpoints": {
    "orcarouter-dsv4.1flash": {
      "endpointId": "orcarouter-dsv4.1flash",
      "firstSeenAt": 1792…, "lastSeenAt": 1792…, "count": 42,
      "sources": { "capture": 40, "probe": 2 },        // 证据来源分桶
      "models": {
        "deepseek-v4.1-flash": {
          "count": 42, "firstSeenAt": …, "lastSeenAt": …,
          "upstreamModelIds": { "deepseek/deepseek-v4.1-flash": 42 },
          "idFamilies": { "hex-native": 42 },           // 响应 id 形态：hex-native / gateway / chatcmpl / uuid
          "contexts": { "https://opencode.ai/zen/go": 42 }
        }
      },
      "lastContext": { "sessionId": …, "logId": …, "rayId": …, "idFamily": …, "status": 200 }
    }
  }
}
```

`endpoints.json` 本身只是累积观测，本仓库不附带整理脚本。需要版本化、带人工身份标注的
登记表时，可以在自己的工具链里读这个文件（schema v1、字段只增不减），把整理结果写在**另一个**
文件里——不要回写插件产物。

## 同层探测与可信度

探测和真实对话不一定走同一层（例如用户自己的端口/网关按会话或路径转发）。插件的处理：

1. **从真实请求反推端点根**：拦截层拿到每条真实对话请求的完整 URL，按
   「去掉 `/messages` 或 `/chat/completions` 后缀 → 去掉末尾 `/v1`、`/anthropic` → 保留 origin + 前缀」
   推导出同一层的 OpenAI 兼容端点根。
   - `https://api.deepseek.com/anthropic/v1/messages` → `https://api.deepseek.com`
   - `https://gw.example.com/ds/anthropic/v1/messages` → `https://gw.example.com/ds`
2. **候选顺序**：本会话真实请求的同源根 → 同 origin 根（网关可能把 OpenAI 路由放在根）→
   配置里的 `openaiBaseURL` → 环境推导默认值。只有「端点不存在（404/405/501）/ 网络不可达」
   才会换下一个候选；认证、限流、上游 5xx 不会静默换层。
3. **带会话头**：探测请求会带上真实对话用过的 `x-deepseek-harness-session-id` /
   `x-deepseek-harness-user-id`，按会话头做路由的网关有机会把探测路由到同一层。
4. **可信度分级**（悬浮卡显示）：

   | 级别 | 含义 |
   | --- | --- |
   | `high` | 探测端点取自本会话真实请求的同源根 |
   | `medium` | 探测端点与对话同 host，但来自同 origin 根/配置层 |
   | `low` | 尚未拦截到本会话真实请求，或真实端点探测失败已回退到配置端点 |

**仍然存在的硬限制**：如果网关按「某一个对话」把请求转发到不同上游，而 Anthropic Messages
端点又不返回 fingerprint，那么任何客户端探测都替代不了网关服务端路由证据——插件能做的是
让探测尽量走同一个入口、并把「探测端点 vs 对话端点」的信心里程碑如实显示出来，不假装确定。
若网关的 OpenAI 兼容路由在完全不同的路径前缀下，请把 `openaiBaseURL` 显式配置成该前缀。

## 网关溯源模式（上游不返回 system_fingerprint）

2026-10-17 实测：把默认路由换到 `opencode-go`（OpenCode Go / Zen 网关，
`https://opencode.ai/zen/go/v1/chat/completions`）之后，**该网关对所有模型一律不返回
`system_fingerprint`**（6 个模型 × 流式/非流式 × 两条网关路径全部无此字段，响应头和 `/models`
里也没有）。这不是「映射表未收录」，而是字段根本不存在——所以插件不再假装能给出检查点，
改成显示网关自己发布的那组**请求级溯源**：

| 默认响应头（语义角色） | 含义 | 稳定性 |
| --- | --- | --- |
| `x-opencode-endpoint-id`（`endpointId`） | 这次请求由哪个**上游端点**服务（`orcarouter-dsv4.1flash`、`manhattan-project`、`deepseek`、`fireworks`、`alibaba-us`…） | 分钟级**整段切换** |
| `x-opencode-upstream-model-id`（`upstreamModelId`） | 真实上游路由（如 `deepseek/deepseek-v4.1-flash`、`accounts/fireworks/models/glm-5p3`） | 随上游端点 |
| `x-opencode-log-id`（`logId`） | 请求级日志 id（地位等同官方路由的 `x-ds-trace-id`） | 每次不同 |
| `x-zen-model`（`zenModel`） / `cf-placement`（`placement`） / `cf-ray`（`rayId`） | 网关模型别名 / 边缘落点 / ray id | 每次不同 |

上面是**默认映射**，不是硬编码。其它网关把同语义的头映射到这六个角色即可（角色之外的键名
会当作附加溯实行展示），也可以整体关掉网关溯源：

```yaml
# 换成别的网关（例如某个自建网关返回 x-upstream-provider / x-request-id）：
gatewayHosts: [gw.example.com]
gatewaySessionHeader: x-session-id      # 网关自己的会话头；false = 不做网关侧关联
gatewayHeaders:
  endpointId: x-upstream-provider       # 徽标主显示取配置里第一个有值的角色
  logId: x-request-id
  cache: x-cache-status                 # 自定义角色 → 卡片里多一行 `cache`
```

**主显示规则**：徽标显示 `gatewayHeaders` 里按配置顺序第一个有值的溯源字段；
默认配置下就是 `endpointId`（后端池）。一个都没有时才回退到通用标签「网关溯源」。

两个必须说清楚的语义限制（悬浮卡里原文写出）：

1. **它不是模型指纹**：标识「请求被路由到哪一层」，不是「模型跑在哪个检查点上」。
2. **它不是逐请求负载均衡**：2026-10-17 实测同一别名在两段窗口之间**整段切换**（15:48–15:51 全
   `manhattan-project`，15:53–16:00 全 `orcarouter-dsv4.1flash`，16:00:46 又切回），同一时刻的
   请求基本都走同一个，没有窗口内交替。所以它**能**告诉你「此刻上游是谁」，但**不能**判断模型版本。

实现要点：

* 拦截范围新增 `gatewayHosts`（默认 `opencode.ai`）。网关路由（pi-ai 适配器）**不带**
  `x-deepseek-harness-*` 头，只靠原有规则一份都抓不到。
* 会话关联改用网关自己的 `x-opencode-session`（取值就是 DSH 的 sessionId）；元数据里记
  `sessionIdSource: gateway`。两条路都拿不到会话 id 时才按 model + 15 分钟时间窗兜底，
  并把可信度降级为 `medium`、`matchedBy: model`，悬浮卡明说「未确认属于本会话」。
* `extractGateway()` 只读响应头，不碰正文；读哪些头由 `gatewayHeaders` 决定。
  原始字节是否落盘由 `captureRaw` 单独决定（默认关，见「隐私默认」）。
* 指纹维度显式标成 `fingerprint.available = false`（`reason: upstream-no-system-fingerprint`），
  **绝不拿官方端点探测到的检查点冒充本会话**。
* `installFetchCapture` 把活跃 env 放进 `Symbol.for('dsh.system-fingerprint.active-env')` 槽位：
  重新启用 bundle（新模块实例）时只换槽位，配置立即生效、不必重启 DSH。

## 关于「响应拦截」

2026-10-17 的实测结论（研究笔记未随仓库分发，结论已收进本文）：对话走的 Anthropic Messages
端点（`/anthropic/messages`）不返回 `system_fingerprint`，DSH 也不落盘原始响应。
因此本插件多做了这一层：

* 在宿主进程给 `globalThis.fetch` 套只读包装，对命中范围的模型响应做 `response.clone()`；
* 在 DSH 适配器解码之前解析**元数据**：model / system_fingerprint / 网关溯源头 / trace id /
  session id / 真实请求 URL，记进 `meta.json`；**默认不把原始字节写到磁盘**；
* 显式 `captureRaw: true` 时才把解码前**原始字节**写到
  `$DSH_HOME/storages/system-fingerprint/raw/`（`.sse` / `.json`）——原始响应体含模型回复正文，
  所以这是隐私相关的**显式 opt-in**，分发版默认关；
* 拦截范围（`capture` 开时）：`captureHosts` 里的 host，**或**任何带 `x-deepseek-harness-*` 头的
  请求——后者覆盖「自定义 baseURL / 网关」场景（适配器仍会带该组头），所以即使对话走用户自己的
  端口也能被观察到并反推同层端点；网关 host 由 `gatewayHosts` 显式列出（默认 `opencode.ai`）；
* 不改、不延迟真实响应流；请求体只解析 `model` 一个字段，**不保存 prompt**；
  `Authorization` / `Cookie` / `x-api-key` 等凭据头始终写成 `<redacted>`，从不落盘；
* 若将来该端点开始返回指纹，或走的是会返回指纹的 OpenAI 兼容路由，
  徽标会优先采用「实际响应」里的指纹（悬浮卡来源显示「已拦截的原始响应」，可信度 `high`）。
  这条不依赖 `captureRaw`：指纹在内存里从 clone 出来的字节解析，不落盘也能用。

当前（2026-10-17）实测：Messages SSE 原始字节里没有 fingerprint 字段，
所以徽标显示的指纹仍来自主动探测；拦截层保存的是元数据证据 + 同层端点证据。

## 开销

* 每次探测是真实 API 调用：实测 `31 prompt + 1 completion = 32 tokens`（`max_tokens:1`）。
* 页面可见时每 10 分钟一次：约 `32 × 144 = 4.6k tokens/天`（轮换检查点的量级，和正常对话相比可忽略，但非零）。
* 点徽标强制刷新、页面刷新/重挂载会额外触发；宿主有 60s 缓存合并短时间内的重复请求。
* 拦截层是本地 `clone()` + 内存解析，**不产生任何额外 API 调用**；
  `captureRaw` 默认关，磁盘上不留模型正文；打开后 raw 目录按 `maxRawFiles` 滚动淘汰。

## 语义

徽标显示的是**当前后端配置指纹**，不是某条历史响应的指纹（探测是「新探测」）。
只有来源显示「已拦截的原始响应」时，才是该请求实际响应里的字段。悬浮卡的
`同层可信度` + `最近一次真实对话响应（与本次探测相差 X）` 是给「是不是同一个」的佐证。
网关模式下显示的是请求级路由证据，不是模型版本指纹（悬浮卡明说）。

存证语义是**默认最小**：`capture` 收元数据（头脱敏、不存 prompt、不存正文），
`captureRaw` 才落原始字节且默认关。想看「什么时候该打开」：需要拿解码前 SSE 原文做离线
证据、或排查响应格式时再开；日常使用保持默认即可。

## 开发与测试

```bash
npm install        # 安装 devDependencies（jsdom / react / react-dom，用于真渲染回归）
npm test           # 218 项离线验收（不联网；无凭据时「真实探测」段自动 SKIP）
npm run test:offline   # 不含 jsdom 真渲染的快速子集
npm run test:render    # 只跑 jsdom + React 18 真挂载回归
```

开发约定：

* 宿主半边保持**单文件、无相对 import**（`file://…?v=N` 热加载的前提）；
* 浏览器半边不直接 import Harness 包（走模块表 `require('react/jsx-runtime')`）；
* 插件代码**零 driftmon 引用**、只写自己的存储目录（接口测试断言）；
* 改对外契约时同步 bump `docs/INTERFACE.md` 的版本号并在 `ROADMAP.md` 记录迁移；
* 改「影响结果但不报错」的路径（枚举顺序、丢样本、参数传递、键映射）时，
  补会大声报错的断言或回归测试，不只靠文档提醒。

## 验证状态

### 离线测试（`npm test`，2026-10-20）

`npm install` 后全量可跑（`devDependencies` 带 jsdom / react，真渲染回归不再 SKIP）：

| 测试文件 | 检查数 | 覆盖 |
| --- | --- | --- |
| `test/fp-host-test.mjs` | 73 | 映射表 md5、端点反推、拦截范围、探测归类/候选/可信度、配置归一化、网关映射默认值 |
| `test/fp-gateway-test.mjs` | 58 | 网关溯源全链路：默认/自定义头映射、会话关联、state 网关模式、登记表、热升级、**captureRaw 默认关的隐私语义** |
| `test/fp-client-test.mjs` | 43 | 卡片行结构/说明/footer、存证隐私三态、告警合并展示、中英文词典、上下翻转定位 |
| `test/fp-gateway-client-test.mjs` | 12 | 网关 / 不适用 / 检查点三个渲染分支、自定义网关字段、旧存证回退 |
| `test/fp-client-render-test.mjs` | 6 | jsdom + React 18 真挂载：hover、点击重探（历史 `const` 重赋值崩溃回归） |
| `test/fp-distribution-test.mjs` | 14 | 分发硬约束：非 private、无本机绝对路径、隐私默认、文档/配置示例、依赖边界 |
| `test/fp-interface-test.mjs` | 12 | 对外契约：HTTP apiVersion / config.json v1 白名单 / 外部告警输入 / 单向依赖 / 文档与版本同步 |

合计 **218 项**。没有凭据时「真实探测」那一段会打印 SKIP（其余照跑）。

### 真实宿主实测（2026-10-17 / 18，历史记录）

* 安装：`plugin_manager install_bundle` → `application: applied`，`warnings: []`；
  槽位 `conversation.session.header.utilities` 占用项 `{ id: 'system-fingerprint', order: -5, active: true }`。
* 主动探测：`GET /api/system-fingerprint/state` 得到 `e72d3c7f…` → 「flash 1017」；
  拦截层反推出真实对话同源根后，探测改走 observed 端点（`confidence: "high"`）。
* 证据拦截（旧版默认落盘时代）：对话 `POST /anthropic/messages` 的 SSE 在解码前完整保存
  （17–400 KB，`fingerprint: null`）；探测 `POST /chat/completions` 的 JSON 也能解析出指纹。
  现在同一套解析默认只在内存里做（`captureRaw: false`），需要落盘才打开。
* 网关溯源上线（路由 `opencode-go / deepseek-v4.1-flash`）：本会话抓到 31 条真实网关响应，
  全部 `sessionIdSource: gateway`、`fingerprint: null`；后端池 `manhattan-project` 29 /
  `orcarouter-dsv4.1flash` 2 —— 同一别名多后端池在真实会话里得到印证。
* 宿主热加载：`file: URL + ?v=N` 递增 + 重新启用 bundle 即可生效，无需重启 DSH（v3→v4 实测）。
* 探针请求带 `x-dsh-system-fingerprint-probe: 1`，不会被算成真实对话证据。

### 发布验证（2026-10-20，0.3.0）

* [x] 仓库内无本机绝对路径；`cordis.patch.yml` 用包名 `dsh-system-fingerprint`（开发期 `?v=N` 仅注释说明）。
* [x] 无 `private: true`；`npm test` 自包含（devDependencies 已声明）。
* [x] 网关 header 映射 / 会话头 / 检查点表全部可配置，并有离线验收覆盖（含自定义网关）。
* [x] `captureRaw` 默认关：默认配置下拦截元数据、不写原始字节（测试 K2 断言 raw 目录为空）。
* [x] 真实宿主回归：live bundle 重载后运行 `lib/index.js?v=11`，生成 `config.json` v1
      （`plugin.version = 0.3.0`、`alerts.enabled = true`、最近检查点 `flash 1017`），
      下游主动监测工具可直接只读消费。
* [x] 浏览器视觉验证：刷新后徽标正常显示检查点名、悬浮卡渲染正常；模拟 warn 告警时
      `⚠` + 警示色 + 「行为告警」行显示正常（验证后已恢复真实 `ok` 状态）。

## 相关仓库

| 仓库 | 角色 |
| --- | --- |
| [`Mizumic/driftmon`](https://github.com/Mizumic/driftmon) | **主动层（可选）**：定时探针组、行为签名、基线、漂移判定、行为模板与告警文件 |

两个仓库互不 import 代码，只靠只读文件契约相连：driftmon 只读本插件的
`endpoints.json`（v1，必需）与 `config.json`（v1，可选），契约见 driftmon 的
`docs/DEPENDENCY.md`。插件代码里零 driftmon 引用（测试断言）——
所以只装插件、不装 driftmon 完全可用，反之亦然。

## 贡献

欢迎 issue / PR。开始前请读 [`CONTRIBUTING.md`](CONTRIBUTING.md)：环境准备、
测试要求、提交规范、隐私与单向依赖的硬约束。行为准则见
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

## 安全

隐私与凭据处理说明见「隐私默认」。安全问题请**不要**开公开 issue，按
[`SECURITY.md`](SECURITY.md) 的渠道私下报告。

## 变更记录

见 [`CHANGELOG.md`](CHANGELOG.md)。版本遵循 [SemVer](https://semver.org/)；
对外契约的变更规则见 [`docs/INTERFACE.md`](docs/INTERFACE.md)「版本与变更流程」。
分发计划与阶段状态见 [`ROADMAP.md`](ROADMAP.md)。

## 许可证

[MIT](LICENSE) © 2026 Mizumic
