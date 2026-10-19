# ROADMAP · 分发就绪（被动层）

> 目标：把 `dsh-system-fingerprint` 从「本机跑通的插件」做成**别人能安装、能配置、能验证**的分发版。
>
> 来源：2026-10-17 的交付讨论（「一体交付、两体运行」四步）与 2026-10-18 的交接待办。
> 姊妹仓库 `driftmon`（主动层）有自己的 `docs/ROADMAP.md`；两者只靠只读文件契约相连。

## 阶段划分

### P0 · 已上线（2026-10-17 / 10-18）

* 检查点徽标：主动探测 `system_fingerprint` → 映射表 → 检查点名；未收录显示原始 md5。
* 同层探测与可信度：从真实请求反推同源端点根，候选顺序 + `high/medium/low` 分级。
* 网关溯源模式：上游不返回指纹时显示后端池 / 上游路由 / 请求 id，并声明「这不是模型指纹」。
* 原始响应拦截 → 元数据 + `endpoints.json` 端点登记表（schema v1，driftmon 只读消费）。
* 点击徽标崩溃（`const` 重赋值）修复 + jsdom 真渲染回归测试。

### P1 · 可分发型（2026-10-20 完成）

验收标准（全部有离线测试或文档覆盖）：

- [x] `cordis.patch.yml` 不再写 `file://` 绝对路径，改用包名安装；`?v=N` 只作为开发期热加载说明。
- [x] `package.json` 去掉 `private: true`。
- [x] 检查点表配置化：`checkpointTable`（只给 `plaintext` 时自行算 md5）。
- [x] 网关 header 映射配置化：`gatewayHeaders` 按语义角色覆盖 / 自定义附加键 / `false` 整体关闭。
- [x] 网关会话头配置化：`gatewaySessionHeader`（`false` = 不做网关侧关联）。
- [x] 隐私默认：`capture`（元数据证据）默认开、`captureRaw`（原始字节）默认关；
      网关溯源不依赖 raw 落盘。
- [x] README：安装、隐私默认、配置表、供应商无关示例、验证状态。
- [x] 测试自包含：`npm install` 后 `npm test` 全量可跑（218 项，含 jsdom + React 真渲染、分发清单与接口契约验收）。
- [x] 网关离线验收从工作区 `.scratch/` 收进仓库（`test/fp-gateway-test.mjs`、
      `test/fp-gateway-client-test.mjs`）。
- [x] 对外契约化：`docs/INTERFACE.md`（HTTP state v1 / `endpoints.json` v1 / `config.json` v1）、
      state 响应带 `apiVersion`、只读配置导出 `config.json`、接口契约测试
      （`test/fp-interface-test.mjs`）。
- [x] 单向依赖保证：插件代码零 driftmon 引用、宿主只 import Node 内建模块、
      只写自己的存储目录（测试断言）；driftmon 侧只读消费，不反向耦合。

### P2 · 最小接缝（等 driftmon Phase 0 噪声标定）

- [x] 插件导出 `endpoints.json`（schema v1；driftmon 只读，版本不认识只告警）。
- [x] provider 只读配置导出 `config.json` v1（白名单、无凭据、含最近检查点）：
      driftmon 的 `loadPluginConfig` 已只读消费（缺失/损坏/版本不认识都只降级告警）。
- [x] 插件展示外部行为告警（`externalAlertFile` 通用 schema v1，display-only）：warn/critical
      合并进指纹徽标（`⚠` + 警示色）与悬浮卡片；文件缺失/损坏/版本不认识静默降级。
      插件仍不感知 driftmon——告警是可选输入，不是代码依赖。
- [x] 已知检查点的「行为向量模板」：官方端点 **5 轮完整巡检**（40 批 / 1440 样本 / 0 错误，
      指纹 `e72d3c7f…` = flash 1017）；driftmon 已生成 `data/templates/checkpoint-flash_1017.json`
      并用 `template check` 产出 `results/watch/gray-watch.json`（当前 stable）。模板是 driftmon
      侧产物，插件只需导出「指纹↔检查点名」（`config.json` 的 `checkpoint` 字段）并可选读取
      告警文件展示（`externalAlertFile`，display-only）。

### P3 · 合并外壳（最后做）

- [ ] 一个 bundle 装两块、一个显式开关、两个数据目录（插件 raw 滚动删 / driftmon raw append-only）。
- 前置：driftmon Phase 0 标定完成（「先标量噪声底，再谈漂移判定」）。
- 明确不做：把主动监测塞回 DSH 插件进程（成本、采样语义、保留策略都冲突，见
  `driftmon/docs/DEPENDENCY.md`）。

### P4 · 开源发布准备（2026-10-20 完成）

按 GitHub 开源仓库的通用标准补齐发布材料（不改运行时行为）：

- [x] MIT `LICENSE`（Copyright 2026 Mizumic）与 `package.json` 的 `license: MIT` 一致。
- [x] README 按发布标准重写：定位、特性、环境要求、安装、隐私默认、配置、
      对外接口、存证目录与**存储预算**、开发与测试、验证状态、相关仓库、贡献/安全/许可证入口。
- [x] 配套社区文件：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`。
- [x] GitHub Actions CI（Node 20 / 22 跑 `npm test`）+ issue / PR 模板。
- [x] `package.json` 发布元数据：`repository` / `homepage` / `bugs` / `engines` / `keywords`；
      `files` 随包分发 `docs`、`LICENSE`、`CHANGELOG.md`。
- [x] 仓库内零本机绝对路径、零凭据、零 raw 存证数据（`test/fp-distribution-test.mjs` 断言）。

## 明确不做

| 事项 | 原因 |
| --- | --- |
| 识别具体版本号 | 原则上不可答：只能观测「变没变」，说不出「变成了什么」 |
| 内容质量评测 / 回归测试 | 属另一件事，需要另一套基准 |
| 自动处置（自动切换 provider） | 先有可信判定再说；误判的自动切换比不切换更危险 |

## 验证口径

* 离线：`npm test`（无凭据时真实探测段自动 SKIP）。
* 真实宿主：安装见 README「安装（分发）」，宿主立即生效、浏览器半边刷新页面。
* 判定类结论不放这里：插件只负责**展示与存证**，漂移判定全部留在 driftmon（可回放）。
