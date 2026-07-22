# 发布检查清单

本清单面向 ScopeLatch 维护者，不是普通使用者的安装步骤。

## 仓库

- [ ] `package.json`、`harness/version.json`、`CHANGELOG.md` 和沙箱镜像标签中的版本一致。
- [ ] README 链接和命令可在全新克隆中运行。
- [ ] 未跟踪运行状态、本机配置、生成报告或测试缓存。
- [ ] `LICENSE`、`NOTICE`、`SECURITY.md` 和贡献指南完整。

## 验证

- [ ] `npm test`
- [ ] `node harness/cli.mjs status`
- [ ] `node harness/cli.mjs index`
- [ ] `node harness/cli.mjs security --profile public-release`
- [ ] 安装器已在临时仓库中验证。
- [ ] Docker 可用时执行 `node harness/cli.mjs sandbox --verify --build`。
- [ ] GitHub Actions 在 Windows 和 Linux 上通过。

## 安全

- [ ] 当前文件密钥扫描没有阻断项。
- [ ] Git 历史扫描没有阻断项。
- [ ] 依赖审计没有高危或严重问题。
- [ ] 不存在本机绝对路径或私有源码引用。
- [ ] 任何曾暴露的凭据均已撤销并从历史中清理。

## 发布

- [ ] 检查提交差异并确认没有生成文件。
- [ ] 推送 `main` 并确认 ScopeLatch CI。
- [ ] 启用 GitHub Private Vulnerability Reporting。
- [ ] 保护 `main` 并要求 ScopeLatch CI 通过。
- [ ] 所有检查完成后再创建签名版本标签。
