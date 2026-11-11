# 文档索引

本目录是插件仓库的**实现与契约文档**。面向使用者的入口在仓库根
[`../README.md`](../README.md)；变更历史见 [`../CHANGELOG.md`](../CHANGELOG.md)；
分发计划与阶段状态见 [`../ROADMAP.md`](../ROADMAP.md)。
所有文档都按「可分发型」编写：不出现本机绝对路径、凭据或个人环境信息。

## 契约（对外，稳定）

| 文档 | 内容 |
| --- | --- |
| [`INTERFACE.md`](INTERFACE.md) | **对外接口契约 v1**：HTTP `/api/system-fingerprint/state`、`endpoints.json` v1、`config.json` v1、可选外部告警文件 v1、版本与变更流程、消费者清单 |
| [`SYMBOLS.md`](SYMBOLS.md) | 安装/验证时用到的符号映射（`${DSH_HOME}`、`${PLUGIN_DIR}` 等）；示例值放在 [`symbols.example.env`](symbols.example.env)，真实取值放本机 gitignored 的 `.local/symbols.env` |

## 实现（内部，可改）

| 文档 | 内容 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 插件内部结构：宿主/浏览器两半边、响应拦截与存证、探测与缓存、同层可信度模型、徽标状态机、数据流与不变量 |
| [`TESTING.md`](TESTING.md) | 离线测试矩阵（每个测试文件覆盖什么、多少断言）、运行方式、测试夹具约定、CI 与已知限制 |

## 安装与运维

| 文档 | 内容 |
| --- | --- |
| [`AGENT-INSTALL.md`](AGENT-INSTALL.md) | 让 DSH agent 安装/升级/验证/回滚本插件的步骤与安全边界 |

## 仓库级文档（根目录）

| 文档 | 内容 |
| --- | --- |
| [`../README.md`](../README.md) | 定位、特性、安装、隐私默认、配置、对外接口摘要、存储预算、开销、验证状态 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本变更记录（Keep a Changelog 格式） |
| [`../ROADMAP.md`](../ROADMAP.md) | 阶段划分（P0–P5）、明确不做、验证口径 |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 开发环境、提交与 PR 约定 |
| [`../SECURITY.md`](../SECURITY.md) | 安全问题的私密报告渠道与范围 |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | 社区行为准则 |

> 内部产物（`meta.json`、`raw/`）不属于对外契约，文档只在 [`ARCHITECTURE.md`](ARCHITECTURE.md)
> 与 README 的「存证目录」中出现，字段随时可改。
