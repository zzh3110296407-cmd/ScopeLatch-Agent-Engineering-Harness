# 发布检查清单

本清单面向 ScopeLatch 维护者，不是普通使用者的安装步骤。

## 仓库

- [ ] `package.json`、`harness/version.json`、`CHANGELOG.md` 和沙箱镜像标签中的版本一致。
- [ ] README 链接和命令可在全新克隆中运行。
- [ ] 未跟踪运行状态、本机配置、生成报告或测试缓存。
- [ ] `LICENSE`、`NOTICE`、`SECURITY.md` 和贡献指南完整。

## 验证

- [ ] `npm test`
- [ ] `npm run test:syntax`
- [ ] `npm run test:unit`
- [ ] `npm run test:contract`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] `npm run ci`
- [ ] `node harness/cli.mjs status`
- [ ] `node harness/cli.mjs index`
- [ ] `node harness/cli.mjs security --profile public-release`
- [ ] 安装器已在临时仓库中验证。
- [ ] 计划只把任务中明确列出的文件写入 `writeTargets`，阅读上下文不会扩大写权限。
- [ ] Stop Hook 能自动生成验证结果、二次 Guard 和 `pr-report.md`。
- [ ] Docker 可用时执行 `node harness/cli.mjs sandbox --verify --build`。
- [ ] GitHub Actions 在 Windows 和 Linux 上通过。
- [ ] `harness/version.json` 的 schema 为 6，活动源码不存在 V3 adapter、V3 adjudicator 或状态升级分支。
- [ ] H0–H9 报告的来源哈希和 predecessor 摘要绑定当前提交。
- [ ] `test-unit` 实际执行验证计划绑定的所有受影响测试选择器。

## 安全

- [ ] 当前文件密钥扫描没有阻断项。
- [ ] Git 历史扫描没有阻断项。
- [ ] 依赖审计没有高危或严重问题。
- [ ] 不存在本机绝对路径或私有源码引用。
- [ ] 任何曾暴露的凭据均已撤销并从历史中清理。
- [ ] H8/H9 报告不包含其它仓库的 Action URL、提交、Artifact、分支保护状态或正式资格。

## 发布

- [ ] 检查提交差异并确认没有生成文件。
- [ ] 推送 `main` 并确认 ScopeLatch CI。
- [ ] 启用 GitHub Private Vulnerability Reporting。
- [ ] 保护 `main` 并要求 ScopeLatch CI 通过。
- [ ] 只有 H8 满足 20 次合格运行、至少 7 天、至少一次信任根变更，且 H9 外部强制策略与正式运行均被观测后，才能要求 `Harness v4 Formal Attestation`。
- [ ] 外部条件未满足时，H8/H9 marker 必须保持 `BLOCKED`，不得因发布 V4 代码而改写为 PASS。
- [ ] 所有检查完成后再创建签名版本标签。
