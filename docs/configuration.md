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

## 执行策略

`policy` 控制写入授权和停止收尾：

- `planMaxAgeMinutes`：计划租约的最长有效时间。
- `requireSessionBinding`：是否要求计划与当前 Codex 会话绑定。
- `requireExplicitWriteTargets`：为 `true` 时，只有任务文本中明确出现的仓库相对文件路径可写。
- `allowOutOfScopeOverride`：是否允许使用 `--allow-out-of-scope`；公开模板默认关闭。
- `autoCloseoutOnStop`：停止 Hook 是否自动执行完整收尾。
- `autoCloseoutTimeoutSeconds`：自动收尾超时，默认 900 秒；Hook 自身超时应略高于此值。

推荐保持四项安全默认值不变。需要增加写入文件时，重新创建计划并写出精确路径，而不是放宽现有租约。

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

V4 命令必须使用闭合的“可执行文件 + 参数数组”契约，不能使用 shell 字符串。通用安装模板将所有能力初始化为 `false`；这表示尚未配置，并会失败关闭。启用强制收尾前，应替换为项目真实命令：

```json
{
  "commands": {
    "lint": {
      "schemaVersion": 1,
      "executable": "npm",
      "args": ["run", "lint"],
      "policy": {
        "network": { "mode": "deny", "allowedDestinations": [] },
        "writablePaths": [".harness/state/resource-locks"]
      }
    },
    "typecheck": {
      "schemaVersion": 1,
      "executable": "npm",
      "args": ["run", "typecheck"]
    },
    "testUnit": {
      "schemaVersion": 1,
      "executable": "npm",
      "args": ["run", "test:unit"]
    },
    "testIntegration": false,
    "testContract": false,
    "testE2E": false,
    "build": false,
    "generateClient": false,
    "fullCI": false
  }
}
```

`false` 只能表示项目确实没有配置该能力；它不能满足要求该能力的高风险不变量。每个命令可以单独声明超时、输出、内存、进程数、网络、环境变量和可写路径。网络默认拒绝；需要联网的不变量必须显式列出允许目标。

字符串命令、`shell: true`、隐式继承全部环境变量或无限制写入路径均不属于正式 V4 命令契约。

需要为 `harness codex` 指定自定义 Codex 启动器时，使用
`HARNESS_CODEX_COMMAND_JSON`，其值必须是 1–32 项的 JSON 字符串数组：

```powershell
$env:HARNESS_CODEX_COMMAND_JSON='["C:\\tools\\codex.exe"]'
```

兼容变量 `HARNESS_CODEX_COMMAND` 只表示一个可执行文件路径，不进行 shell
拆词，也不接受附加参数或控制符。ScopeLatch 始终以 `shell: false` 执行该
命令；需要前置参数时必须使用 JSON 数组。

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
