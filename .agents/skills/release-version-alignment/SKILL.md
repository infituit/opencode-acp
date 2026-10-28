---
name: release-version-alignment
description: Use when preparing a new opencode-acp release or checking/fixing package version and bilingual changelog alignment before tagging. Trigger on "prepare release", "next release", "准备新版本", "版本对齐", or "可以打 tag 了吗". Not for pipeline debugging, moving published tags, or unrelated runtime changes.
---

# Release Version Alignment

对齐 ACP 的 package 版本、双语 changelog 和安装引用，准备发布 PR。

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

保留工作区中的无关修改。发布分支基于最新 canonical base，命名为 `YYYY-MM-DD_short-title`。

## 3. 编写双语发布说明

使用 `.agents/skills/changelog-doc/SKILL.md`，基于已确认发布窗口的实际 diff、PR 和实现事实归纳影响。缺少说明时先补齐，不把 raw commit list 当成发布说明。

先向用户展示发布说明草稿并确认，再写入最终版本路径。重要兼容性或升级事实不明时，单独报告给编写者；不要把未完成核实事项塞进 changelog。修正既有文件中的机械版本引用无需重启完整撰写流程。

## 4. 检查版本对齐

- 检查三个 package 版本字段一致，tag 为 `v${package.version}`，符合版本规范。
- 检查双语文件名、日期和版本行一致，安装示例指向目标 tag。
- 审阅 `git diff` 与 `git diff --check`，确认没有无关字段、依赖或历史说明变更。
- 根据改动运行已有 `npm run typecheck`、`npm run check:package` 与针对目标文件的格式检查。
- 提交后运行 `bash scripts/ci/check-pr.sh <head-branch> <canonical-base-ref>`，检查 `BASE...HEAD` 的版本和 changelog 差异。

Release 工作流负责 tag 校验、正式构建和出包。

## 5. 提交与 PR

使用 `opencode-acp-create-github-pr`，保持版本对齐变更原子化。标题示例：

```text
chore: prepare v2.0.0-release.2 release --issue=#123
```

默认 `Related: #123` 或 `refs #123`。仅当 Issue 真正完成且用户明确要求合并关闭时使用 closing keyword。

## 6. 合并后再打 tag

参照 [tag workflow](references/tag-workflow.md)，对已合入官方默认分支的最终发布提交创建并推送附注 tag，由 GitHub Actions 构建和发布。

`phase` 为 `release` 创建正式 GitHub Release，其他阶段为预发布。已发布 tag 的修复方式见[发布流程](../../../docs/developer/release.md#失败与重试)。

## 交付

报告目标版本、发布范围、双语说明路径、检查结果、提交和 PR 链接。
