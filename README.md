# ScopeLatch Agent Engineering Harness

ScopeLatch Agent Engineering Harness 是面向 AI Coding智能体的工程控制系统。它把自然语言任务转化为一条受约束、可验证、可审计的工程流程：选择上下文、分析影响范围、签发写入租约、规划验证、检查差异、有限返工、生成报告并沉淀失败知识。

## 解决的问题

编码智能体可以快速修改代码，但在大型仓库中经常因读取错误版本、越界修改、漏改下游契约、复用过期计划或未完成验证而失败。Harness 通过仓库证据和完整闭环约束这些风险。

```text
任务
  -> 仓库索引与权威源码
  -> 上下文包
  -> 影响报告与风险等级
  -> 验证计划与会话绑定写入租约
  -> 写入前策略检查
  -> 智能体修改
  -> 写入后差异守卫
  -> 分层验证图
  -> 第二次守卫
  -> PR 报告与失败知识
```

## 核心能力

- 区分正式源码、参考资料、历史版本和生成文件的仓库索引。
- 支持中英文任务解析、文件指向和风险提示。
- L1-L4 影响分级与跨模块同步要求。
- 将写入权限绑定到任务、会话、分支、提交、有效期、基线和影响范围。
- Codex 写入前、写入后和停止前 Hook。
- 检测越界修改、运行数据、测试删除、锁文件、API 漂移、密钥、本机路径和许可证问题的 Diff Guard。
- 分层验证、完整收尾、有限返工和机器可读 PR 报告。
- 失败规则必须经过人工审核后才能提升为稳定规则。
- 面向公开发布的当前文件、Git 历史、依赖、凭据、高熵内容、本机路径和许可证扫描。
- 可选的强化 Docker 执行环境：禁用网络、只读挂载、移除 capabilities、限制资源，写入必须显式授权。

## 环境要求

- Node.js 24 或更高版本。
- Git。
- 启用 Codex Hook 时需要 Python 3.11 或更高版本。
- 只有使用强化沙箱时才需要 Docker。
- 只有 `harness codex` 需要 Codex CLI；规划、守卫、验证、报告和安全扫描可独立运行。

运行时不依赖第三方 npm 包。
本项目通过 GitHub 分发；`package.json` 中的 `private` 仅用于防止误发布到 npm，并不代表仓库闭源。

## 在本仓库中体验

```bash
npm test
node harness/cli.mjs status
node harness/cli.mjs index
node harness/cli.mjs plan "在不修改无关文件的前提下完善 API 验证"
```

运行结果会写入 `.harness/`，并由 `.gitignore` 排除。

## 安装到其它仓库

克隆本仓库后，在本仓库根目录执行：

```bash
node scripts/install.mjs --target "../your-project"
```

Windows PowerShell 也可以使用绝对路径：

```powershell
node scripts/install.mjs --target "D:\projects\your-project"
```

安装器会复制引擎、Hook 和通用配置，不会删除文件；未指定 `--force` 时会保留已有目标文件。如果目标仓库已有 `AGENTS.md`，规则会写入 `AGENTS.harness.md`，由你审查后合并。

随后在目标仓库中执行：

```bash
node harness/cli.mjs status
node harness/cli.mjs index
node harness/cli.mjs plan "描述第一个任务"
```

请检查 `.harness/harness.config.json`，并把其中的 `auto` 验证命令替换为项目真实命令。详细说明见[配置文档](docs/configuration.md)。
首次安装时，只要必要命令尚未配置，`status` 就会按设计返回非零状态；完成配置后请再次运行，并确认结果为健康。

## 启用 Codex Hook

为避免安装过程在未告知的情况下改变智能体策略，Hook 默认只复制、不启用。确认配置后执行：

```powershell
Copy-Item .codex/config.example.toml .codex/config.toml
```

```bash
cp .codex/config.example.toml .codex/config.toml
```

也可以在安装时主动启用：

```bash
node scripts/install.mjs --target "../your-project" --enable-hooks
```

## 日常流程

修改前创建并阅读计划：

```bash
node harness/cli.mjs plan "新增接口并同步更新客户端"
```

重点阅读 `.harness/runs/<run>/` 中的：

- `context-pack.md`
- `impact-report.json`
- `validation-plan.json`
- `codex-prompt.md`

完成修改后执行：

```bash
node harness/cli.mjs closeout --run .harness/runs/<run>
```

公开发布前执行：

```bash
node harness/cli.mjs security --profile public-release
```

运行不可信命令时使用强化沙箱：

```bash
node harness/cli.mjs sandbox --verify --build
node harness/cli.mjs sandbox --build -- <command> [args...]
```

沙箱内写入仓库必须显式增加 `--write-workspace`，之后仍需通过 Harness Guard。

## 安全边界

Harness 是控制系统，不是操作系统级沙箱。Hook 和 Guard 可以在支持的工作流中阻止或发现违规，但无法从物理层拦截所有写入方式。执行恶意或未知代码时，请使用容器或更强隔离。启用强制策略前请阅读[安全模型](docs/security-model.md)与[漏洞报告说明](SECURITY.md)。

## 文档

- [架构](docs/architecture.md)
- [配置](docs/configuration.md)
- [安全模型](docs/security-model.md)
- [来源与范围](docs/origin-and-scope.md)
- [参与贡献](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 许可证

本项目采用 Apache License 2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
