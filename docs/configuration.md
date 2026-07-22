# 配置说明

## 配置读取顺序

ScopeLatch 按以下顺序读取配置，找到第一份可用文件后停止：

1. `.harness/harness.config.json`
2. `harness.config.json`
3. `.harness/harness.config.example.json`

安装器会创建 `.harness/harness.config.json`，并用 `.harness/.gitignore` 保护本机运行配置。团队需要共享同一策略时，应额外维护一份经过审查的示例配置。

## 仓库与状态

- `repoName`：供人阅读的仓库名称。
- `packageManager`：`auto`、`npm`、`pnpm`、`yarn` 或项目支持的值。
- `outputDir`：运行档案目录，通常为 `.harness/runs`。
- `stateDir`：本机租约与会话状态目录，通常为 `.harness/state`。

## 源码优先级

`context.sourcePriority` 决定哪些文件应被视为权威来源：

- `canonicalSourceRoot`：当前正式源码根，通常为 `.` 或 `src`。
- `autoDetectCanonicalSource`：启用后自动选择满足条件的源码根。
- `authorityManifestPath`：可选的正式源码就绪清单。
- `requireAuthorityManifest`：清单无效时是否让健康检查失败。
- `activeSourceRoots`：当前实现路径。
- `referenceSourceRoots`：架构和支持性资料路径。
- `historicalPathPatterns`：需要强降权的历史版本。
- `generatedPathPatterns`：不应成为必读源码的生成证据。

存在多个竞争源码版本时，可以修改 [`templates/source-authority.example.json`](../templates/source-authority.example.json)，将其跟踪为 `.harness/source-authority.json`，并声明就绪文件及验证配置。

## 验证命令

通用模板初始使用 `auto`。启用强制收尾前，应替换为项目真实命令：

```json
{
  "commands": {
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "testUnit": "npm run test:unit",
    "testIntegration": "npm run test:integration",
    "testContract": "npm run test:contract",
    "testE2E": "npm run test:e2e",
    "build": "npm run build",
    "generateClient": "none",
    "fullCI": "npm run ci"
  }
}
```

只有项目确实不存在某项能力时才能使用 `none`。ScopeLatch 会把不可用检查标记为不可用或跳过，不会伪装成通过。

## 变更预算

- `maxRepairRounds`：允许的自动修复轮数上限。
- `forbiddenDirs`：普通任务永远不得修改的目录。
- `escalateOn`：触发更高风险等级和更深验证的信号。

## 安全配置

- `private-development`：凭据和严重依赖问题会阻断；本机路径产生警告；根许可证可选。
- `public-release`：本机路径和许可证缺失也会成为阻断项，并启用发布导向检查。

不要为了隐藏发现而削弱扫描。文档和测试必须使用占位凭据；已经泄露的真实凭据需要撤销并清理 Git 历史。

## 配置健康检查

```bash
node harness/cli.mjs status
```

健康检查覆盖权威源码、必要忽略项、禁止运行目录、命令可用性、阶段无关入口、风险规则和安全配置。
