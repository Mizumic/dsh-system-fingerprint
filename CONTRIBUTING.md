# 贡献指南（Contributing）

感谢你愿意改进 `dsh-system-fingerprint`。这个项目对**隐私默认**、**依赖方向**和
**接口契约**有硬约束，开始之前请先读完本文件。

## 环境准备

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 20`（CI 在 20 / 22 上跑） |
| DSH | `0.2.0-rc.2` 或更高（只有真实宿主联调时需要） |

```bash
git clone https://github.com/Mizumic/dsh-system-fingerprint.git
cd dsh-system-fingerprint
npm install        # devDependencies: jsdom / react / react-dom
npm test           # 218 项离线验收，不联网
```

`npm test` 不需要真实 API key：无凭据时「真实探测」段会自动 SKIP，其余全量运行。
提交 PR 前必须让 `npm test` 全绿。

## 可以做什么

- 修 bug、补测试、改进文档（欢迎先开 issue 描述问题）。
- 新增可配置项时，保持**默认值向后兼容**。
- 新增网关映射/检查点表条目时，同步补离线测试。

## 硬约束（会被测试或评审拒绝）

1. **单向依赖**：插件代码里**零** driftmon（或任何外部监测项目）引用；宿主半边只
   `import 'node:…'` 内建模块；浏览器半边不直接 import `@deepseek-ai/*` 包。
2. **宿主半边保持单文件、无相对 import**：这是 `file://…?v=N` 热加载的前提。
3. **只写自己的存储目录**：`$DSH_HOME/storages/system-fingerprint/`，不碰宿主/其他插件的文件。
4. **隐私默认不倒退**：`captureRaw` 默认 `false`；请求体只解析 `model` 一个字段；
   `Authorization` / `Cookie` / `x-api-key` 等凭据头一律写成 `<redacted>`；
   不保存 prompt、不在日志里打印凭据。
5. **不提交本机环境产物**：凭据、`.env`、绝对路径、raw 存证文件、`node_modules/`。
6. **契约变更走流程**：改 `docs/INTERFACE.md` 里的字段/语义必须 bump 对应版本号，
   在本文件与 `ROADMAP.md` 记录迁移说明，并同步 `test/fp-interface-test.mjs`。
7. **「影响结果但不报错」的路径要补断言**（枚举顺序、丢样本、参数传递、键映射）：
   补会大声报错的断言或回归测试，不只靠文档提醒。

## 本地联调（可选，需要 DSH）

宿主半边是单文件模块，开发期可在 profile patch 里临时把插件行写成：

```yaml
- id: system-fingerprint
  name: 'file:///绝对路径/dsh-system-fingerprint/lib/index.js?v=N'
  config:
    # …
```

每次改完宿主代码把 `N` 递增，然后在 DSH 插件页把该 bundle **关→开**（或
`plugin_manager set_bundle` 关→开）即生效；**浏览器半边改完刷新页面**即可。
验证方法与证据收集见 README「验证状态」。

> 注意：本地联调用的 `file://` 写法只用于开发，**不要提交进仓库模板**；
> `test/fp-distribution-test.mjs` 会断言发行版 patch 不出现本机绝对路径。

## 提交与 PR

- 提交信息建议用 `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` 前缀；
  中文或英文均可，首行简洁，正文可写动机与验证方式。
- 一个 PR 只做一件事；行为变更请附带测试与文档改动。
- 提交前自查：

  - [ ] `npm test` 全过
  - [ ] 没有凭据 / 本机绝对路径 / raw 存证数据
  - [ ] 隐私默认未改变（`captureRaw` 默认关、凭据 redacted）
  - [ ] 单向依赖保持（零 driftmon 引用）
  - [ ] 改契约时：`docs/INTERFACE.md` 版本 + `ROADMAP.md` 迁移记录 + 接口测试已更新
  - [ ] 用户可见行为变化已写入 `CHANGELOG.md`

## 行为准则

参与本项目即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。
