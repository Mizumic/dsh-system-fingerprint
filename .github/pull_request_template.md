## 这个 PR 做了什么

<!-- 一句话说明；关联的 issue 用 "Closes #123" -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能 / 新配置项（向后兼容）
- [ ] 文档
- [ ] 测试 / CI
- [ ] 重构（不改变行为）

## 验证方式

<!-- 贴关键命令与结果；真实宿主联调请写明 DSH 版本与路由类型 -->

```bash
npm test
```

## 检查清单

- [ ] `npm test` 全过（218 项，无凭据时真实探测段 SKIP）
- [ ] 没有提交凭据 / `.env` / 本机绝对路径 / raw 存证数据
- [ ] 隐私默认未改变（`captureRaw` 默认 `false`、凭据 `<redacted>`、不存 prompt）
- [ ] 单向依赖保持（插件零 driftmon 引用；宿主只 import `node:` 内建模块）
- [ ] 用户可见行为变化已写入 `CHANGELOG.md`
- [ ] 改对外契约时：`docs/INTERFACE.md` 版本 + `ROADMAP.md` 迁移记录 + 接口测试已同步
