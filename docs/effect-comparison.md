# ScopeLatch 演进证据

本文只报告可复算的仓库结构和控制能力，不声称未经对照实验验证的效率提升、缺陷率下降或事故避免数量。

## 当前结论

ScopeLatch 4.0.0 保留了 V3.4 的 17 项基础工程控制，并新增 10 项 V4 信任边界控制。当前工作树包含：

- 35 个 `harness/lib/**/*.mjs` 引擎模块；
- 37 个 `harness/tests/*.test.mjs` 测试文件；
- 1,229 次受支持的静态 `assert.*` 调用；
- 17/17 项基础控制；
- 10/10 项 V4 信任控制。

这些数字代表实现和验证表面积，不是质量分数。V4 正式资格还需要独立的 H8/H9 外部证据；当前为 `0/20` 次合格 GitHub Actions 观察，Formal 保持 `BLOCKED`。

## 演进表

| 阶段 | 基础控制 | 引擎模块 | 测试文件 | 断言出现次数 | 主要变化 |
|---|---:|---:|---:|---:|---|
| 未使用 Harness | 0 / 17 | 0 | 0 | 0 | 无计划、范围、验证或证据控制 |
| 初版项目感知原型 | 5 / 17 | 14 | 8 | 86 | 上下文、影响分析、验证图、Guard |
| 项目实测优化 | 8 / 17 | 17 | 12 | 179 | 有限修复、报告和失败知识 |
| Harness V3.2 | 14 / 17 | 27 | 24 | 332 | 会话绑定、安全扫描、沙箱 |
| Harness V3.3 | 15 / 17 | 27 | 25 | 377 | 强制收尾和提交前证据 |
| ScopeLatch 4.0.0 | 17 / 17 | 35 | 37 | 1,229 | V4-only、密封证据、Auditor、安全执行和正式资格层 |

V3.4.0 是 V4 迁移前的公开发布点，具备 17/17 基础控制、27 个模块、26 个测试文件和 452 次断言出现。V4 的机器可读公开阶段替换为当前 4.0.0 工作树，避免 CI 继续把旧提交当成当前实现。

## V4 信任控制

1. 闭合 outcome，不接受 status-only PASS。
2. 内容寻址证据链和 predecessor 摘要。
3. Git 候选提交/树绑定。
4. 可执行不变量目录。
5. 独立 Auditor 重算。
6. 并发原子状态。
7. 默认禁网的安全执行器。
8. 受保护基线 Judge 的 H8 Shadow 资格。
9. 失败关闭的 H9 Formal Cutover。
10. 唯一活动 V4 运行时，无 V3 adapter。

## 历史使用证据

2026-07-06 至 2026-07-23 的原项目归档下限为：

| 证据类型 | 数量 | 说明 |
|---|---:|---|
| 运行目录 | 125 | 其中 111 个包含版本化 `run-manifest.json` |
| 验证结果 | 56 | 37 passed、13 passed-or-skipped、6 failed |
| 首次 Guard | 53 | 15 passed、7 passed-with-warnings、31 failed |
| 验证后 Guard | 14 | 9 passed、3 passed-with-warnings、2 failed |
| PR 报告 | 21 | 表示生成可审阅报告，不等同于远程 PR 数量 |

这些归档混合真实任务、受控负向测试、基准、失败和中断。它们证明控制路径被执行，不证明避免了多少生产事故，也不能换算为节省工时。

原项目运行档案、GitHub Action 观察和强制策略不会迁移为 ScopeLatch 开源仓库的 H8/H9 资格。

## 复算

机器可读数据位于 [`docs/evidence/scope-evolution-baseline.json`](evidence/scope-evolution-baseline.json)。

```bash
npm run evidence:verify
npm test
node harness/cli.mjs security --profile public-release
```

维护者拥有原项目 Git 历史时，可以额外复核私有历史阶段和运行档案下限：

```bash
node scripts/verify-effect-comparison.mjs --private-source "<source-repository-path>"
```

## 未作出的声明

- 没有同任务随机对照实验，因此不声称节省多少开发时间。
- 没有统一标注逃逸缺陷，因此不声称缺陷率降低多少。
- 单一复杂项目的长期使用不能自动外推到所有仓库。
- 静态断言数量不等于独立测试用例数量。
- 本地 H0–H9 契约通过不等于 GitHub 正式资格。
- ScopeLatch 不是操作系统级沙箱；恶意代码仍需容器、虚拟机或更强隔离。
