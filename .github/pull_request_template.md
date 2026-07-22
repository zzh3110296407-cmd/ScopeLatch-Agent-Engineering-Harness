## 问题

说明本次变更解决的仓库级错误、风险或能力缺口。

## 变更

说明实现内容以及受影响的 ScopeLatch 控制边界。

## 验证

- [ ] `npm test`
- [ ] `node harness/cli.mjs status`
- [ ] `node harness/cli.mjs security --profile public-release`
- [ ] 已执行覆盖本次行为的聚焦测试

## 风险

列出 Hook、Guard、验证、安全、兼容性或迁移风险。未执行的检查必须说明具体原因。
