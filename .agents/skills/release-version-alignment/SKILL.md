---
name: release-version-alignment
description: Use when preparing a new opencode-acp release or checking/fixing package version and bilingual changelog alignment before tagging. Trigger on "prepare release", "next release", "准备新版本", "版本对齐", or "可以打 tag 了吗". Not for pipeline debugging, moving published tags, or unrelated runtime changes.
---

# Release Version Alignment

为 ACP 准备发布提交，或检查既定版本的遗漏项。移植 bk-nodemgr 的“版本对齐 → 双语 changelog → PR → 合并后 tag”流程，版本字段采用 ACP 的 package 元数据，不引入 Helm 或 API Gateway 步骤。

## 先读规则

- `AGENTS.md` 和改动路径的 scoped rules。
- `docs/concepts/version_management.md`：版本命名与阶段。
- `docs/developer/release.md`、`.github/workflows/release.yml`：实际发布入口与校验。
- `package.json`、`package-lock.json`、最近一组 `support-files/changelog/{zh,en}/` 文件。
- `.agents/skills/opencode-acp-create-github-pr/SKILL.md`：Issue、分支、PR 和远端写入确认。

规范、工作流和已存在的版本事实若冲突，先报告并询问，不自行更改版本规则。

## 1. 确定目标和范围

区分两种任务：

- **完整发布准备**：对齐 package 版本、lockfile 与双语发布说明，按需更新安装示例，再交付 PR。
- **对齐补漏**：目标版本已确认，只修正遗漏的版本字段或发布说明；不能借机升级版本或重写发布机制。

读取当前分支、工作区、用户给定提交与 canonical base 的差异；确认来源提交、目标版本、发布日期和发布窗口。不要从提交标题推断某个提交已经可发布。

版本格式为 `v{major}.{minor}.{patch}-{phase}.{serial}[-{mark}]`。Git tag 带 `v`；package 和 lockfile 不带 `v`。

用户未指定版本时，先核对官方仓库的 tag 与已确认发布记录。在基础版本、阶段和可选标记均不变且前一版明确时，可提出递增 `serial` 的候选版本，如 `v2.0.0-release.1` → `v2.0.0-release.2`。不要把 `mark` 中的数字当成迭代号。没有 tag、版本存在分叉或需要变更阶段时，询问用户；不以 Git 的排序结果代替版本决策。候选版本得到确认后再编辑。

## 2. 保持最小对齐范围

完整发布需要：

| 文件                                                    | 对齐内容                               |
| ------------------------------------------------------- | -------------------------------------- |
| `package.json`                                          | `version`                              |
| `package-lock.json`                                     | 顶层 `version`、`packages[""].version` |
| `support-files/changelog/zh/v<version>_<YYYY-MM-DD>.md` | 目标版本、日期、中文发布说明           |
| `support-files/changelog/en/v<version>_<YYYY-MM-DD>.md` | 同一版本、日期和事实的英文发布说明     |

每种语言恰好一份目标版本文件，正文包含 `Version: v<version>`。遵循 `changelog-doc` 的版本块格式。

仅在安装引用或兼容性要求变化时更新 README 等用户文档。不要改 lockfile 的依赖版本、运行时代码、持久化格式、配置、工作流或历史发布说明；若任务确实需要这些变更，先确认扩大范围。

工作区有无关修改或分支混有无关提交时，保留用户工作，使用基于最新 canonical base 的干净分支或 worktree。沿用本项目 `YYYY-MM-DD_short-title` 分支格式，不照搬 nodemgr 的 Helm 分支名。用户明确要求合并交付时按批准范围处理，不擅自拆分。

## 3. 编写双语发布说明

使用 `.agents/skills/changelog-doc/SKILL.md`，基于已确认发布窗口的实际 diff、PR 和实现事实归纳影响。缺少说明时先补齐，不把 raw commit list 当成发布说明。

先向用户展示发布说明草稿并确认，再写入最终版本路径。重要兼容性或升级事实不明时，单独报告给编写者；不要把未完成核实事项塞进 changelog。修正既有文件中的机械版本引用无需重启完整撰写流程。

## 4. 验证对齐，不发明发布门槛

- 检查三个 package 版本字段一致，tag 为 `v${package.version}`，符合版本规范。
- 检查双语文件名、日期和版本行一致，安装示例指向目标 tag。
- 审阅 `git diff` 与 `git diff --check`，确认没有无关字段、依赖或历史说明变更。
- 根据改动运行已有 `npm run typecheck`、`npm run check:package` 与针对目标文件的格式检查。
- 提交后运行 `bash scripts/ci/check-pr.sh <head-branch> <canonical-base-ref>`；该脚本读取 `BASE...HEAD` 的已提交差异，不能用未提交文件的结果冒充最终提交通过。

Release 工作流会再次校验 tag、lockfile 与双语说明，并负责正式构建和出包。本 skill 不新增校验脚本，不在发布准备中临时创建 API smoke、运行时 E2E 或本机正式发布产物。报告未运行的检查及其边界，不把旧提交或旧 CI 结果当作当前验证。

## 5. 提交与 PR

使用 `opencode-acp-create-github-pr`，保持版本对齐变更原子化。标题示例：

```text
chore: prepare v2.0.0-release.2 release --issue=#123
```

默认 `Related: #123` 或 `refs #123`。仅当 Issue 真正完成且用户明确要求合并关闭时使用 closing keyword。

分别确认推送、创建或修改 Issue、创建或修改 PR。发布准备或 PR 获批都不等于允许打 tag 或发布。不要从本机上传正式 Release 包，不执行 `npm publish`。

## 6. 合并后再打 tag

参照 [tag workflow](references/tag-workflow.md) 和发布文档，确认最终已合入官方默认分支的发布提交，包括所有补漏提交。只有用户另行批准后才创建并推送 tag；GitHub Actions 负责构建和发布。

`phase` 为 `release` 创建正式 GitHub Release，其他阶段为预发布。已经推送的 tag 不得自动移动、删除或强推。失败恢复不属于对齐补漏，应单独处理。

## 交付

报告目标版本、模式、发布窗口、引用提交、改动字段、双语说明路径、检查结果、分支和提交。若涉及 PR，列出 Issue 关系与 PR base/head/URL；明确哪些远端操作已做、哪些尚未授权。不要把“对齐完成”说成“已发布”。
