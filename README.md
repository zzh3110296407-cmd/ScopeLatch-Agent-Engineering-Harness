# ScopeLatch Agent Engineering Harness

[![ScopeLatch CI](https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness/actions/workflows/ci.yml)

**让每一次智能体改动都有边界、有证据、有验证。**

ScopeLatch Agent Engineering Harness 是面向 AI 编码智能体的项目感知工程控制系统。它把自然语言任务转化为受约束、可验证、可审计的工程闭环，降低智能体在复杂仓库中读错源码、越界修改、漏改下游契约、复用过期计划或未经验证便结束任务的风险。

- 当前版本：`3.4.0`
- 许可证：Apache License 2.0

## 核心流程

```text
任务
  -> 仓库索引与权威源码识别
  -> 上下文包
  -> 影响报告与 L1-L4 风险分级
  -> 精确写入目标与会话绑定写入租约
  -> 写入前策略检查
  -> 智能体修改
  -> 写入后差异守卫
  -> 分层验证图
  -> 第二次差异守卫
  -> 停止时自动收尾
  -> PR 报告与失败知识沉淀
```

## 核心能力

- 区分正式源码、参考资料、历史版本和生成文件，优先选择当前权威实现。
- 分析直接目标、反向依赖、跨模块同步要求和 L1-L4 变更风险，同时将这些内容保持为只读上下文。
- 仅把任务中明确写出的文件路径纳入 `writeTargets`，并将写入权限绑定到任务、会话、分支、提交、基线和有效期。
- 通过 Codex `PreToolUse`、`PostToolUse` 和停止 Hook 约束执行过程，并在停止时自动完成收尾。
- 使用 Diff Guard 检测越界修改、测试删除、运行数据、锁文件漂移和公共契约遗漏。
- 按风险执行静态检查、单元测试、集成测试、契约测试、E2E 与构建验证。
- 支持最多指定轮数的聚焦修复、机器可读报告和人工审核后的失败规则沉淀。
- 扫描当前文件、Git 历史、依赖、凭据、高熵内容、本机路径和许可证问题。
- 提供可选的强化 Docker 执行环境，默认禁网、只读挂载并限制进程权限与资源。

## 真实演进效果

| 阶段 | 可核验控制项 | 测试文件 | 关键结果 |
|---|---:|---:|---|
| 未使用 Harness | 0 / 17 | 0 | 没有范围、验证或审计控制 |
| 初版原型 | 5 / 17 | 8 | 有计划与 Guard，但没有写后副作用检查或强制闭环 |
| V3.2 | 14 / 17 | 24 | 加入会话绑定、权威源码、安全扫描和沙箱 |
| V3.3 | 15 / 17 | 25 | 未完成完整收尾时禁止提交 |
| ScopeLatch 3.4.0 | 17 / 17 | 26 | 精确写入授权，并在停止时自动闭环 |

以上数据来自固定 Git 提交树、125 个长期运行目录和公开 CI，不使用估算的“效率提升百分比”。查看[完整效果对照、原始数据与复现方法](docs/effect-comparison.md)，或运行：

```bash
npm run evidence:verify
```

## 环境要求

- Node.js 24 或更高版本
- Git
- Python 3.11 或更高版本，仅 Codex Hook 需要
- Docker，仅强化沙箱需要
- Codex CLI，仅 `harness codex` 命令需要

ScopeLatch 运行时不依赖第三方 npm 包。`package.json` 中的 `private` 只用于防止误发布到 npm，不代表仓库闭源。

## 快速体验

```bash
git clone https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness.git
cd ScopeLatch-Agent-Engineering-Harness
npm test
node harness/cli.mjs status
node harness/cli.mjs index
```

创建第一个受控任务：

```bash
node harness/cli.mjs plan "修改 src/api/orders.ts 和 tests/orders.test.ts，完善订单 API 验证"
```

计划结果保存在 `.harness/runs/<run>/`，其中最重要的文件是：

- `context-pack.md`：本次任务应阅读的上下文。
- `impact-report.json`：精确写入目标、只读影响范围、风险和同步要求。
- `validation-plan.json`：本次任务必须执行的验证图。
- `codex-prompt.md`：供编码智能体执行的受控提示。

这些运行文件只保存在本机，并由 `.gitignore` 排除。

## 安装到其它仓库

在 ScopeLatch 仓库根目录执行：

```bash
node scripts/install.mjs --target "../your-project"
```

安装器会复制核心引擎、Codex Hook 和通用配置，不会删除目标仓库文件。未指定 `--force` 时，已有目标文件会被保留；目标仓库已有 `AGENTS.md` 时，ScopeLatch 规则会写入 `AGENTS.harness.md`，等待人工审查合并。

随后进入目标仓库：

```bash
node harness/cli.mjs status
node harness/cli.mjs index
node harness/cli.mjs plan "描述第一个任务"
```

请检查 `.harness/harness.config.json`，将其中的 `auto` 验证项替换为项目真实命令。配置尚未完成时，`status` 会按设计返回非零状态，而不会把缺失能力伪装成通过。

任务描述必须写出所有预计修改的仓库相对路径。`Must Read`、直接目标、反向依赖和相关测试只授予阅读与验证上下文，不会自动扩大写入权限；发现遗漏路径时，应重新创建计划。

## 启用 Codex Hook

Hook 默认只复制、不启用。审查配置后选择当前系统对应的命令：

```powershell
Copy-Item .codex/config.example.toml .codex/config.toml
```

```bash
cp .codex/config.example.toml .codex/config.toml
```

也可以在安装时显式启用：

```bash
node scripts/install.mjs --target "../your-project" --enable-hooks
```

## 日常使用

修改前创建计划，并明确列出预计写入的文件：

```bash
node harness/cli.mjs plan "修改 src/api/orders.ts、src/client/orders.ts 和 tests/orders.contract.test.ts，新增订单接口并同步客户端"
```

启用 Hook 后，Codex 停止时会自动执行首次 Guard、验证、二次 Guard 和 PR 报告。未启用 Hook、手动工作或 CI 中也可以显式执行完整收尾：

```bash
node harness/cli.mjs closeout --run .harness/runs/<run>
```

公开发布前执行安全检查：

```bash
node harness/cli.mjs security --profile public-release
```

运行不可信命令时使用强化沙箱：

```bash
node harness/cli.mjs sandbox --verify --build
node harness/cli.mjs sandbox --build -- <command> [args...]
```

沙箱默认只读。确需写入仓库时必须显式增加 `--write-workspace`，写入结果仍需通过 Guard 和验证闭环。

## 仓库结构

```text
ScopeLatch-Agent-Engineering-Harness/
|-- harness/                 核心引擎、验证器、测试与 Docker 沙箱
|-- scripts/                 面向其它仓库的安装器
|-- templates/               安装时使用的通用配置与规则模板
|-- docs/                    架构、配置、安全边界与项目背景
|-- .codex/                  Codex Hook 与示例配置
|-- .harness/                本仓库自身的受控策略和权威源码声明
|-- .github/                 CI、Issue 与 Pull Request 模板
|-- AGENTS.md                本仓库的智能体协作规则
|-- README.md                中文使用入口
|-- CONTRIBUTING.md          贡献指南
|-- SECURITY.md              漏洞报告方式
|-- LICENSE / NOTICE         开源许可与声明
`-- package.json             命令与项目元数据
```

`.harness` 中被版本控制的是公开策略和源码权威声明；`runs`、`state`、`cache`、`security` 等运行结果均被忽略。`.codex` 中只包含 Hook 源码和示例配置，不包含个人 Codex 配置。

## 安全边界

ScopeLatch 是工程控制系统，不是操作系统或虚拟机级沙箱。Hook 和 Guard 可以阻止或发现受支持工作流中的违规行为，但无法物理拦截所有写入方式。执行恶意或未知代码时，应使用容器、虚拟机或更强隔离。

## 文档

- [架构设计](docs/architecture.md)
- [配置说明](docs/configuration.md)
- [安全模型](docs/security-model.md)
- [项目来源与开源范围](docs/origin-and-scope.md)
- [参与贡献](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [变更记录](CHANGELOG.md)

## 许可证

本项目采用 [Apache License 2.0](LICENSE)，附加声明见 [NOTICE](NOTICE)。
