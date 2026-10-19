# 变更记录（Changelog）

本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

对外契约（HTTP / 文件）的变更规则见 [`docs/INTERFACE.md`](docs/INTERFACE.md)「版本与变更流程」。

## [Unreleased]

### Changed

- **开源发布准备**：README 重写为 GitHub 发布标准结构（新增目录、环境要求、存证目录与
  **存储预算**、开发与测试、相关仓库、贡献/安全/许可证入口）；新增 `CONTRIBUTING.md`、
  `SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、GitHub Actions CI、issue/PR 模板、
  `CODEOWNERS`、dependabot 配置；`cordis.patch.yml` 把 `captureRaw: false` 写成显式一行；
  `package.json` 增加 `repository` / `homepage` / `bugs` / `engines` / `keywords`，
  并随包分发 `LICENSE`、`CHANGELOG.md`。运行时行为无变化。
- **CI 维护**：GitHub Actions 升级到 `actions/checkout@v7` / `actions/setup-node@v7`
  （消除 Node 20 runner 弃用告警）；dependabot 对 `react` / `react-dom` 忽略 major 版本
  （渲染回归仍基于 React 18，适配后再放开）；README 增加 CI 状态徽章。
- **文档澄清**：`docs/SYMBOLS.md` 最后一列明确标注「示例（占位，非本机值）」，`docs/symbols.example.env` 头部也强调全部是占位符——避免把示例路径误读为「本机映射被入库」。真实映射只在 gitignored 的 `.local/symbols.env`。
- **DSH agent 安装文档 + 本机符号映射**：新增 `docs/AGENT-INSTALL.md`（agent 安装/升级/验证/
  回滚与安全边界）与 `docs/SYMBOLS.md`（`${DSH_HOME}`、`${PLUGIN_DIR}` 等本机字段的符号映射表，
  实际取值放 gitignored 的 `.local/symbols.env`）；仓库文档不再出现本机绝对路径。
  主仓迁移为 GitHub。

## [0.3.0] - 2026-10-20

### Added

- **对外接口契约化 v1**（`docs/INTERFACE.md`）：
  - `/api/system-fingerprint/state` 所有响应统一带 `apiVersion: 1`；
  - 新增只读配置导出 `$DSH_HOME/storages/system-fingerprint/config.json`（v1，字段白名单、
    不含凭据、含最近探测到的 checkpoint），供外部工具只读消费；
  - 新增接口契约测试（`test/fp-interface-test.mjs`，12 项）。
- **行为告警合并展示**：新增可选配置 `externalAlertFile`（通用外部告警文件 v1，display-only）。
  warn/critical 时徽标追加 `⚠` 并转警示色，悬浮卡片增加「行为告警」与 changed 通道行；
  文件缺失/损坏/版本不认识一律静默降级——插件不感知、也不依赖任何产出方。
- **单向依赖与分发边界测试**：插件代码零外部监测项目引用、宿主只 import Node 内建模块、
  只写自己的存储目录（测试断言）。

### Changed

- 版本 `0.2.0 → 0.3.0`（向后兼容：只加字段/能力，不改既有字段语义）。
- `package.json` 增加 `repository` / `homepage` / `bugs` / `engines` / `keywords`，
  并随包分发 `LICENSE` 与 `CHANGELOG.md`。
- 文档：重写 README（GitHub 发布标准结构 + 存储预算 + 贡献/安全/许可证入口），
  新增 `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、CI 与 issue/PR 模板。

### Fixed

- 无（本版本无行为缺陷修复）。

## [0.2.0] - 2026-10-20

### Added

- **分发就绪**：`package.json` 去掉 `private: true`，`cordis.patch.yml` 改用包名安装
  （不再写 `file://` 本机绝对路径；`?v=N` 仅保留为开发期热加载说明）。
- **隐私默认**：`capture`（元数据证据）默认开、`captureRaw`（原始字节，含模型回复正文）
  默认关；默认配置下不写 raw 文件，由测试断言锁定。
- **供应商无关配置**：检查点表 `checkpointTable`、网关响应头映射 `gatewayHeaders`
  （按语义角色覆盖/自定义附加键/整体关闭）、网关会话头 `gatewaySessionHeader` 全部可配置。
- 自包含离线测试 209 项（含 jsdom + React 真渲染回归、分发清单验收、网关溯源全链路）。

### Changed

- 网关溯源不再依赖 raw 落盘：响应头解析在内存完成，`captureRaw: false` 也能工作。

## [0.1.0] - 2026-10-18

### Added

- 初始独立仓库（从 DSH 工作区抽出插件主体：`lib/` + 包清单 + bundle patch）。
- 检查点徽标：主动探测 `system_fingerprint` → 内置 MD5 映射表 → 检查点名，
  未收录显示原始 md5。
- 同层探测与可信度分级（`high` / `medium` / `low`）：从真实请求反推同源端点根。
- 网关溯源模式：上游不返回指纹时显示后端池 / 上游路由 / 请求 id，
  并明确声明「这不是模型指纹」。
- 响应拦截 → 元数据 + `endpoints.json` 端点登记表（schema v1）。
- 浏览器半边：会话头部徽标 + 自定义悬浮卡片；点击强制重新探测。
- 点击徽标 `const` 重赋值崩溃修复 + jsdom 真渲染回归测试。
