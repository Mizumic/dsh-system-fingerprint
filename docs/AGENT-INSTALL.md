# DSH Agent 安装指南（dsh-system-fingerprint）

> **面向对象**：在 DSH（DeepSeek Harness）环境里替用户执行安装/升级/验证的 **agent**。
> 人类安装也可以照做，只是本指南刻意写成「可逐步验证、失败可回滚」的 agent 流程。
>
> **两个前置文档**：
> * [`SYMBOLS.md`](SYMBOLS.md)：本机符号映射表（`${DSH_HOME}`、`${PLUGIN_DIR}` 等），
>   实际取值放 `.local/symbols.env`（gitignored）；
> * [`INTERFACE.md`](INTERFACE.md)：对外接口契约（验证步骤会引用）。

## 0. 适用范围与前置条件

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| DSH | `>= 0.2.0-rc.2`（需要 bundle patch 与 plugin 管理能力） | 询问用户 / 看 `$DSH_PROFILE_DIR` |
| Node.js | `>= 20` | `node -v` |
| 仓库 | 已 clone 到 `${REPO_DIR}`，工作区干净 | `git -C "${REPO_DIR}" status --short` |
| 凭据 | 只需**环境变量名**；不需要把 key 交给 agent | `echo "${PROBE_API_KEY_ENV:-DEEPSEEK_API_KEY}"` |

> 变更范围：安装/启用 DSH profile 里的 bundle；不修改 DSH 宿主源码。
> 浏览器半边需要用户 **F5 刷新页面**，agent 无法代替。

## 1. 初始化符号映射（agent 第一步）

```bash
cd "${REPO_DIR}"
mkdir -p .local
[ -f .local/symbols.env ] || cp docs/symbols.example.env .local/symbols.env
# 按 docs/SYMBOLS.md 校验/补齐；DSH_* 优先用会话注入的环境变量
set -a; . .local/symbols.env; set +a
```

自检（都应成功）：

```bash
node -v                                    # v20+
echo "${DSH_HOME:?缺少 DSH_HOME}" "${DSH_PROFILE:?缺少 DSH_PROFILE}"
echo "${DSH_CHECKOUT:?缺少 DSH_CHECKOUT}"
test -d "${REPO_DIR}/lib" && echo repo-ok
```

解析规则见 [`SYMBOLS.md`](SYMBOLS.md) §3：**推不出来就问用户，不要猜路径写进配置**。

## 2. 离线验证（不碰 live，失败即中止）

```bash
npm install --no-audit --no-fund
npm test
```

期望：**218 项全过**；没有凭据时「真实探测」段打印 SKIP，其余照跑。
不通过就不要继续安装——先修/报告失败用例。

## 3. 安装 / 升级（二选一）

### A. 分发安装（推荐，用户机器首次安装）

用 DSH 的插件管理器安装本仓库 bundle：

```text
plugin_manager install_bundle('${REPO_DIR}')
```

期望返回 `application: applied`、`warnings: []`。随后验证（§4）。

### B. 开发热加载（agent 在本机改代码时）

宿主半边是**单文件、无相对 import**，可按 `file: URL + ?v=N` 热加载：

1. 确保 `${PLUGIN_DIR}/lib/index.js` 与仓库 `lib/` 同步（开发期由部署者维护该 live 目录）。
2. 把 `${BUNDLE_PATCH}` 里插件行的 `name` 改成
   `file://${PLUGIN_DIR}/lib/index.js?v=N`，**每次改宿主代码把 N 递增**。
3. 让 bundle 重新应用（等价于 UI 插件页「关→开」）：

```text
plugin_manager set_bundle('dsh-system-fingerprint', false)
plugin_manager set_bundle('dsh-system-fingerprint', true)
```

两个调用都应返回 `application: applied`、`warnings: []`。

> **已知坑（P8）**：如果运行中的行与持久 patch 的 `moduleName` 不一致（例如运行中还是 `?v=10`、
> patch 已改 `?v=11`），`list_plugins` 会把它标记 `readOnlyReason: "unaddressable"`，
> 此时 `set_plugin` 无法按行寻址——**用上面的 `set_bundle` 关→开**即可换成新模块并恢复可寻址。

安装/升级完成后提醒用户：**浏览器半边需要 F5**。

## 4. 验证清单（逐条给出证据，缺一不可）

| # | 检查 | 命令 / 位置 | 期望 |
| --- | --- | --- | --- |
| 1 | 运行模块已更新 | `plugin_manager list_plugins` → `include:system-fingerprint` | `enabled: true`、`fiberPhase: active`、`moduleName` 含预期 `?v=N`；有 `patchId`（可寻址） |
| 2 | 只读配置已生成 | `${CONFIG_JSON}` | `version: 1`、`plugin.version: <当前版本>`、`plugin.stateApiVersion: 1`、`alerts.enabled` 与配置一致 |
| 3 | 端点登记表 | `${ENDPOINTS_JSON}` | `version: 1`，`endpoints` 为对象 |
| 4 | 近期探测到的检查点 | `${CONFIG_JSON}` 的 `checkpoint` | `fingerprint` 32 位 hex；已知检查点应有 `name`（如 `flash 1017`） |
| 5 | 浏览器徽标 | 用户 F5 后看会话头部 | 显示检查点名 / 网关溯源 / `不适用`；悬停卡片正常；`level=ok` 时无 `⚠` |
| 6 | 下游联动（可选） | 若装 driftmon：`node bin/driftmon.mjs status` | 输出「只读配置 v1」与「当前检查点：<name> · <fingerprint>」 |

> 无法执行第 5 项时（agent 无浏览器控制），明确报告「浏览器侧未验证，需用户 F5 确认」，
> 不要仅凭安装返回 `applied` 就宣称用户可以看到徽标。

## 5. 升级

1. `git -C "${REPO_DIR}" pull --ff-only`（GitHub 是主仓）
2. `npm test`（218 项）通过
3. 按 §3 重新安装/热加载（热加载要递增 `?v=N`）
4. 重跑 §4 验证；在报告里写清旧版本 → 新版本

回滚：`git checkout <tag>` 后重复 §3/§4；产物目录（`${STORAGE_DIR}`）按需保留（`config/endpoints`
是契约、`meta/raw` 是证据）。

## 6. 卸载

```text
plugin_manager set_bundle('dsh-system-fingerprint', false)   # 或从 profile bundles 移除
```

浏览器刷新后徽标消失。`${STORAGE_DIR}` 里的文件不会自动删除；如需清理，先备份再删
（`raw/` 里可能含模型回复正文，删除不受影响；`config.json`/`endpoints.json` 可再生成）。

## 7. 安全边界（硬约束，agent 不得违反）

1. **凭据**：只通过环境变量名（`apiKeyEnv`）引用；不读取、不打印、不写入、不提交任何 key。
2. **隐私默认**：不要替用户打开 `captureRaw`（会落盘模型回复正文）；外部告警文件只读。
3. **写入范围**：只写 `${STORAGE_DIR}`；不修改 DSH 宿主源码/其他插件目录。
4. **本机字段**：只写符号或 `.local/symbols.env`；不要把绝对路径写进仓库文件。
5. **变更告知**：live 变更后明确告知「需要 F5」，并列出做了哪几步。

## 8. 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `set_plugin` 报 `unaddressable` | 运行中模块名与 patch 不一致（见 P8） | 用 `set_bundle` 关→开 |
| 徽标「缺少凭据」 | `apiKeyEnv` 指名的环境变量未设置 | 设置环境变量后点击徽标重探 |
| 徽标「不适用」 | 当前路由上游不发布 `system_fingerprint`，也未配网关溯源 | 配置 `gatewayHosts`/`gatewayHeaders`，或接受「不适用」 |
| 浏览器仍显示旧徽标 | 浏览器半边未刷新（旧模块在页面内存里） | 让用户 F5 |
| `${CONFIG_JSON}` 不存在 | 新模块未真正加载（还在旧模块） | 回 §4 第 1 条核对 `?v=N`，再关→开 bundle |
| `config.json` 里 `alerts.enabled: false` | 没有配置 `externalAlertFile`（预期） | 需要告警联动时在 profile 配置该路径 |
