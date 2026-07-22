# 参与贡献

感谢你帮助改进 ScopeLatch。

## 开始之前

1. 涉及行为、强制规则或兼容性的变更，请先创建 Issue 说明问题和预期结果。
2. 保持 Pull Request 聚焦，并说明要解决的仓库级风险。
3. 不要提交凭据、私有仓库内容、专有代码、本机绝对路径或未脱敏报告。

## 开发环境

- Node.js 24 或更高版本
- Python 3.11 或更高版本
- Git
- Docker，可选，仅用于沙箱验证

开始修改前先创建 ScopeLatch 计划：

```bash
node harness/cli.mjs plan "描述本次变更"
```

完成修改后运行：

```bash
npm test
node harness/cli.mjs status
node harness/cli.mjs security --profile public-release
```

涉及强制策略的变更必须同时覆盖允许和拒绝路径。Hook 应继续保持仅依赖 Python 标准库。配置、命令或公开行为发生变化时，应同步更新 README、相关文档和测试。

## Pull Request 内容

请说明：

- 问题与预期行为；
- 修改的文件和控制边界；
- 执行过的验证命令及结果；
- 安全、兼容性或迁移影响；
- 未执行的检查、原因和剩余限制。

不要通过削弱测试或安全检查来获得通过结果。提交贡献即表示你同意该贡献按 Apache License 2.0 授权。
