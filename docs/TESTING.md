# 测试说明（内部）

> 目标：**离线、自包含、不联网**；没有凭据时真实探测段自动 SKIP，其余全部照跑。
> 测试文件同时是对外契约与分发约束的可执行版本，改行为时先改测试。

## 1. 运行

```bash
npm install            # devDependencies：jsdom / react / react-dom（真渲染回归用）
npm test               # 全量：244 项离线验收
npm run test:offline   # 不含 jsdom 真渲染的快速子集
npm run test:render    # 只跑 jsdom + React 18 真挂载回归
npm run test:fresh     # 只跑「可信度实时重算 + 黄点自动复检」两条回归
```

* Node `>= 20`；Node 内建测试不需要额外框架。
* CI（`.github/workflows/ci.yml`）在 Node 20 / 22 上跑 `npm test`。
* 宿主与浏览器两个半边都是纯 JS，测试直接 import/加载，不需要构建。

## 2. 测试矩阵

| 文件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `fp-host-test.mjs` | 74 | 检查点表（有明文校验 md5、无明文校验指纹形态）、配置归一化、端点反推、拦截范围与归类、探测候选顺序、同层可信度、缓存命中、网关头映射、存证落盘 |
| `fp-gateway-test.mjs` | 58 | 网关溯源全链路：默认/自定义头映射、会话关联、state 网关模式、端点登记表、热升级、`captureRaw` 默认关的隐私语义 |
| `fp-gateway-fallback-test.mjs` | 16 | 上游不披露端点标识时的降级：固定桶、不产生 UUID 假端点、徽标回退、`endpointDisclosed`、历史污染幂等迁移、官方路径不受影响 |
| `fp-client-test.mjs` | 43 | 悬浮卡行结构/说明/footer、存证隐私三态、告警合并、中英词典、上下翻转定位 |
| `fp-gateway-client-test.mjs` | 12 | 网关 / 不适用 / 检查点三个渲染分支、自定义网关字段、旧存证回退 |
| `fp-client-render-test.mjs` | 6 | jsdom + React 18 真挂载：hover、点击重探（历史 `const` 重赋值崩溃回归） |
| `fp-distribution-test.mjs` | 14 | 分发硬约束：非 private、无本机绝对路径、隐私默认、文档/配置示例、依赖边界 |
| `fp-interface-test.mjs` | 12 | 对外契约：HTTP `apiVersion` / `config.json` v1 白名单 / 外部告警输入 / 单向依赖 / 文档与版本同步 |
| `fp-confidence-fresh-test.mjs` | 3 | **同层可信度按当前观测重算**：缓存命中不沿用旧结论、慢探测不覆盖点击结果、会话端点变更后不冒充同源 |
| `fp-client-retry-test.mjs` | 6 | **黄点判据与自动复检**：`needsConfidenceRetry` 的触发/排除条件、`badgeOf` 的绿点/警示色/A-B/告警/网关分支 |

合计 **244 项**。`fp-confidence-fresh-test` 与 `fp-client-retry-test` 是 0.3.3 为修复
「徽标持续黄、点击后不立即恢复」补的回归。

## 3. 测试夹具约定

* **临时 `DSH_HOME`**：测试把 `process.env.DSH_HOME` 指到仓库内的临时目录（如 `.test-home`），
  结束后清理；不会读写真实用户的存证。
* **假上游**：需要探测的用例用假 `fetch` 返回固定 `system_fingerprint`，不联网、不计费；
  模拟慢请求用延迟，模拟失败用非 2xx。
* **假凭据**：stub 的 credentials 服务返回固定字符串；测试从不打印真实 key。
* **无凭据 SKIP**：真实探测段在没有凭据时打印 `SKIP live probe`，不影响退出码。
* **jsdom 真渲染**：`react` / `react-dom` 从 devDependencies 解析；没有安装时渲染测试会跳过或失败，
  因此 CI 必须先 `npm install`。

## 4. 写新测试的约定

1. **会大声失败**：优先断言返回值/副作用，不用「打印 + 人眼检查」；
2. **覆盖静默路径**：枚举顺序、缓存命中、并发顺序、丢样本、键映射这类「不报错但会改变结果」的改动，
   必须补回归（项目约定见 README「开发与测试」）；
3. **契约变更同步**：改 `docs/INTERFACE.md` 时同步 `fp-interface-test.mjs` 的断言；
4. **分发约束**：新增仓库文件/文档后跑 `fp-distribution-test.mjs`，确认没有引入本机绝对路径、
   `private` 包或默认落盘原始字节；
5. **不联网**：新增用例不得依赖真实上游；需要真实端点验证时写成 SKIP 段。

## 5. 已知限制

* 真实探测覆盖需要凭据与可达上游，离线只验证请求构造与结果组装；
* 浏览器半边的自动复检按纯函数（`needsConfidenceRetry`）与颜色判据（`badgeOf`）测试，
  未做计时器驱动的整段渲染测试；
* 渲染测试固定 React 18（dependabot 忽略 React 大版本，适配后再放开）；
* 测试不计时，因此不用于性能/开销验收（开销口径见 README「开销」）。
