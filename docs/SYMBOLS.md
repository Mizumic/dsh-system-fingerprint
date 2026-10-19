# 本机符号映射表（Symbols）

> **本文件只是「符号定义」文档；表格里的示例路径是占位示意，不是本机真实路径。**
> 真实取值放在仓库根目录的 `.local/symbols.env`（gitignored，模板见
> [`symbols.example.env`](symbols.example.env)）；由 agent / 部署者按本表解析后 `source` 使用。
> 这样仓库可以公开分发，同一份文档在任意机器上通过映射表落地。

## 1. 符号表

> ⚠️ 最后一列是**示例（占位，非本机值）**，只说明路径形态；真实值只在 `.local/symbols.env`
> （gitignored，永不入库）。**不要**把本机真实路径复制回任何 tracked 文件。

| 符号 | 含义 | 解析方式（优先级从上到下） | 示例（占位，非本机值） |
| --- | --- | --- | --- |
| `REPO_DIR` | 本仓库根目录 | `git -C <当前目录> rev-parse --show-toplevel` | `~/projects/dsh-drift/dsh-system-fingerprint` |
| `DSH_HOME` | DSH 数据目录（`storages/`、`profiles/`、`sessions/` 所在处） | ① 环境变量 `DSH_HOME`（DSH 会话自动注入）② `.local/symbols.env` | `~/projects/dsh-0.2.0-rc.2/home` |
| `DSH_PROFILE` | 当前 profile 名 | ① 环境变量 `DSH_PROFILE` ② `.local/symbols.env` | `web` |
| `DSH_PROFILE_DIR` | profile 目录 | ① 环境变量 `DSH_PROFILE_DIR` ② `${DSH_HOME}/profiles/${DSH_PROFILE}` | `${DSH_HOME}/profiles/web` |
| `DSH_CHECKOUT` | DSH 检出/安装目录（`plugins/` 所在处） | ① `.local/symbols.env` ② `${DSH_HOME}` 去掉末尾 `/home` 的父目录 | `~/projects/dsh-0.2.0-rc.2` |
| `PLUGIN_DIR` | live 插件目录（**仅开发热加载用**；分发安装不需要它） | ① `.local/symbols.env` ② 约定 `${DSH_CHECKOUT}/plugins/dsh-system-fingerprint` | `${DSH_CHECKOUT}/plugins/dsh-system-fingerprint` |
| `BUNDLE_PATCH` | live profile patch 文件 | `${PLUGIN_DIR}/cordis.patch.yml` | `${PLUGIN_DIR}/cordis.patch.yml` |
| `STORAGE_DIR` | 插件存储目录（本插件唯一写入位置） | `${DSH_HOME}/storages/system-fingerprint` | `${DSH_HOME}/storages/system-fingerprint` |
| `CONFIG_JSON` | 只读配置导出 v1（对外契约） | `${STORAGE_DIR}/config.json` | 同左 |
| `ENDPOINTS_JSON` | 端点登记表 v1（对外契约） | `${STORAGE_DIR}/endpoints.json` | 同左 |
| `META_JSON` | 最近 40 条拦截元数据（内部产物） | `${STORAGE_DIR}/meta.json` | 同左 |
| `RAW_DIR` | 原始响应字节（仅 `captureRaw: true` 时存在，内部产物） | `${STORAGE_DIR}/raw` | 同左 |
| `DRIFTMON_DIR` | 主动监测仓库目录（可选；用于外部告警联动） | ① `.local/symbols.env` ② 同级目录 `../driftmon` | `~/projects/dsh-drift/driftmon` |
| `EXTERNAL_ALERT_FILE` | 可选外部行为告警文件（driftmon `template check` 输出） | `${DRIFTMON_DIR}/results/watch/gray-watch.json` | 同左 |
| `PROBE_API_KEY_ENV` | 主动探测凭据的**环境变量名**（不是凭据值） | 配置项 `apiKeyEnv` 的默认值 | `DEEPSEEK_API_KEY` |

## 2. `.local/symbols.env`

```bash
mkdir -p .local
cp docs/symbols.example.env .local/symbols.env
# 按本机实际路径填写，然后：
set -a; . .local/symbols.env; set +a
```

文件内容是一组 `KEY=VALUE`（可互相引用，已 `set -a` 导出为环境变量）。它被 `.gitignore` 忽略，
**不要提交**；换机器时重新填一份即可。

## 3. 解析规则（agent 必读）

1. 先读环境变量（DSH 会话会注入 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR`）。
2. 再读 `.local/symbols.env`（覆盖/补齐）。
3. 仍缺的按上表「推导」列计算；无法推导时**问用户**，不要猜一个路径写进配置。
4. 任何输出/报告里只写符号名或相对路径；需要展示真实值时说明「本机值」且不要写进仓库文件。
5. 判断是否泄漏：`git grep -nE '/home/|/Users/|/srv/'` 应当没有业务路径命中（测试里显式断言的假路径除外）。

## 4. 与分发的关系

* 公开仓库不依赖 `.local/symbols.env`：没有任何映射时，插件用 `$DSH_HOME` 推导默认存储目录，
  driftmon 用 `plugin.dshHome` → `DSH_HOME` → `<repo>/../home` 的顺序找插件产物。
* 映射表只是让 **agent 能在具体机器上可靠落地**（尤其 live 热加载、外部告警文件路径这类
  「本机才有」的值），不是仓库运行时的依赖。
