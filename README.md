# ScopeLatch Agent Engineering Harness

[![ScopeLatch CI](https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness/actions/workflows/ci.yml)

**让每一次智能体改动都有边界、有证据、有独立判定。**

ScopeLatch 是面向 AI 编码智能体的仓库级工程控制系统。它把自然语言任务转换为受约束的计划、精确写入租约、确定性验证图、密封证据和独立审计结果。

- 当前引擎：`4.0.0`
- 许可证：Apache License 2.0
- 运行时：仅 V4；V3 只存在于 Git 历史和历史说明中，不参与当前判定
- 正式资格：尚未激活。当前仓库 H8 真实 GitHub Actions 资格窗口为 `0/20`，H9 保持 `BLOCKED`

## V4 信任链

```text
任务
  -> 仓库索引与权威源码识别
  -> 只读上下文包与影响图
  -> 精确 writeTargets 和会话租约
  -> 写入前策略检查
  -> 候选改动
  -> Diff Guard
  -> 安全执行器运行分层验证
  -> 第二次 Diff Guard
  -> 内容寻址证据索引
  -> 独立 Auditor 重算结论
  -> 本地证明 / CI Shadow / Formal Attestation
```

V4 使用闭合结果集合：

```text
PASS | FAIL | BLOCKED | ERROR | CANCELED | NOT_APPLICABLE
```

缺失、跳过、状态字符串、过期证据或不可验证证据不能被提升为 `PASS`。

## 核心能力

- 从任务中提取精确写入目标；只读上下文不会扩大写权限。
- 将租约绑定到任务、会话、分支、提交、基线和有效期。
- 对实际 Git 候选树执行写入边界、同步、删除和受保护路径检查。
- 用可执行文件与参数数组运行命令，默认禁网、限制环境、输出和可写目录。
- 为 H0–H9 信任不变量保存内容寻址证据，并由独立 Auditor 重算。
- 对并发状态使用原子更新与锁，不接受跨运行证据混用。
- 提供 Windows GitHub Actions Shadow 与 Formal 工作流；候选分支不能替换受保护基线 Judge。
- 扫描当前文件、Git 历史、凭据形态、高熵内容、本机路径、依赖和许可证。
- 提供可选 Docker 沙箱；它增强隔离，但不等同于操作系统或虚拟机安全边界。

## 环境要求

- Node.js `24.11.0` 或兼容的 Node 24
- Python `3.12.10` 或兼容的 Python 3.12（Codex Hook 和执行器）
- Git
- Docker（仅沙箱验证需要）
- Codex CLI（仅 Codex Hook/受控进程流程需要）

运行时不依赖第三方 npm 包。`private: true` 只用于防止误发布到 npm，不代表仓库闭源。

## 快速验证

```bash
git clone https://github.com/zzh3110296407-cmd/ScopeLatch-Agent-Engineering-Harness.git
cd ScopeLatch-Agent-Engineering-Harness
npm test
node harness/cli.mjs status
node harness/cli.mjs security --profile public-release
```

创建受控任务时，必须列出每个预计写入的仓库相对路径：

```bash
node harness/cli.mjs plan "修改 src/api/orders.ts 和 tests/orders.test.ts，完善订单 API 验证"
```

阅读生成的：

- `.harness/runs/<run>/context-pack.md`
- `.harness/runs/<run>/impact-report.json`
- `.harness/runs/<run>/validation-plan.json`

只修改 `impact-report.json.writeTargets`。需要增加文件时重新创建计划。

完成后执行：

```bash
node harness/cli.mjs closeout --run .harness/runs/<run>
```

## 安装到其它仓库

```bash
node scripts/install.mjs --target "../your-project"
```

安装器复制 V4 引擎、Auditor、契约、执行器、Hook 和保守模板，不会删除目标仓库文件。已有文件默认保留；只有显式使用 `--force` 才允许覆盖。

进入目标仓库后：

```bash
node harness/cli.mjs init
node harness/cli.mjs status
```

然后编辑本地 `.harness/harness.config.json`，为项目提供真实的结构化验证命令。模板中的 `false` 表示能力尚未配置；它不会被伪装成通过。

## 启用 Codex Hook

先审查示例，再复制：

```powershell
Copy-Item .codex/config.example.toml .codex/config.toml
```

或在安装时显式启用：

```bash
node scripts/install.mjs --target "../your-project" --enable-hooks
```

本机 `.codex/config.toml` 不应提交。

## CI 与正式资格

- `ScopeLatch CI`：执行本仓库回归、状态检查和公开发布扫描。
- `Harness v4 Shadow`：非权威观察；始终 `continue-on-error`，不允许合并或发布。
- `Harness v4 Formal Attestation`：失败关闭；只有 H8 窗口、外部 GitHub 强制策略和精确候选树全部满足时才能产生正式证明。

仓库中跟踪的 H8/H9 报告明确记录当前外部证据不足。不得把“V4 代码已安装”解释为“正式资格已激活”。

## 安全边界

ScopeLatch 是工程控制平面，不是内核、Hypervisor 或恶意代码隔离器。Hook 依赖宿主平台提供受支持的工具事件；Git Guard 无法观察仓库外副作用。运行未知或恶意代码时，请使用容器、虚拟机或更强隔离，并使用最小权限凭据。

## 文档

- [架构设计](docs/architecture.md)
- [配置说明](docs/configuration.md)
- [安全模型](docs/security-model.md)
- [演进证据](docs/effect-comparison.md)
- [项目来源与开源范围](docs/origin-and-scope.md)
- [参与贡献](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [变更记录](CHANGELOG.md)

V4 的规范、H0–H9 报告和运维手册位于 [`.harness/docs`](.harness/docs/)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)，附加声明见 [NOTICE](NOTICE)。
