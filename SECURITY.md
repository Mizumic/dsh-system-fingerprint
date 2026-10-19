# 安全策略（Security Policy）

## 支持版本

| 版本 | 安全更新 |
| --- | --- |
| `0.3.x` | ✅ 支持 |
| `< 0.3` | ❌ 不再支持（请升级） |

## 报告漏洞

**请不要为安全漏洞开公开 issue。**

- 首选渠道：GitHub 私有漏洞报告
  <https://github.com/Mizumic/dsh-system-fingerprint/security/advisories/new>
- 也可以直接联系维护者（见仓库主页），说明复现步骤与影响。

报告里请包含：受影响版本、复现步骤、影响范围（是否泄露凭据/正文/路径、是否可越权读取存证），
以及你建议的修复方向（可选）。维护者会尽快确认并给出处理时间线；修复发布前不会公开细节。

## 安全范围

这个插件会拦截模型响应并保存证据，因此以下问题属于安全范围：

- **凭据泄露**：插件把 `Authorization` / `Cookie` / `x-api-key` 等凭据以明文写入任何产物
  （`meta.json` / `raw/` / `config.json` / 日志 / HTTP 响应）。
- **隐私默认被破坏**：默认配置（`captureRaw: false`）下写出模型回复正文（`raw/` 文件）。
- **越权读取**：状态接口 `/api/system-fingerprint/state` 绕过宿主鉴权/校验，
  或外部可读取非本会话的存证。
- **路径穿越 / 任意写**：通过配置或响应内容把文件写到存储目录之外。
- **契约文件信息泄露**：`config.json` / `endpoints.json` 里出现凭据值或本机绝对路径
  （白名单导出本应不含这些）。
- **依赖供应链**：`package.json` 引入非必要的运行时依赖（宿主代码应只用 Node 内建模块）。

## 明确的设计边界（不是漏洞）

- 插件默认拦截并保存**响应元数据/响应头**（脱敏后）；这是核心功能，可用 `capture: false` 关闭。
- 显式开启 `captureRaw: true` 会把**模型回复正文**写入本地磁盘（滚动淘汰，默认上限约 60 MiB）；
  这是存证场景的显式 opt-in，由部署方承担数据保管责任。
- 徽标展示的 `system_fingerprint` 是**上游供应商的声明**，插件无法验证其真实性；
  这是本项目要观测的对象，不是被测对象的安全弱点。
- 插件不评估上游模型/网关的内容安全与合规性。

## 加固建议

- 生产环境保持 `captureRaw: false`（默认）；确需存证时限制目录权限并定期清理 `raw/`。
- 用 `config.json` 的 `alerts.enabled` / `capture.rawEnabled` 审计部署是否符合预期。
- 凭据只放在环境变量或 DSH credentials 服务里，不写进 profile patch 之外的任何文件。
