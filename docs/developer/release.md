# 发布流程

ACP 的构建与发布由 GitHub Actions 完成。维护者先准备发布提交并合并到 `master`，再对该提交推送版本 tag，由 tag 触发 [Release 工作流](../../.github/workflows/release.yml)。

发布仅通过 GitHub 分发。CI 与 Release 工作流都不会发布到 npm、修改包版本、创建发布提交或推送 tag。

## 准备发布提交

使用 coding agent 准备发布时，可使用项目的 `release-version-alignment` skill 对齐版本，使用 `changelog-doc` skill 整理双语发布说明，再由 `opencode-acp-create-github-pr` 处理 PR 交付。它们不会自动打 tag 或发布。

1. 按[版本管理规范](../concepts/version_management.md)确定版本。将 `package.json` 的版本与 `package-lock.json` 中的两处版本号更新为目标版本。例如 `2.0.0-release.1` 对应 tag `v2.0.0-release.1`。
2. 为每种语言各新增一份发布说明：
    - `support-files/changelog/en/v<version>_<YYYY-MM-DD>.md`
    - `support-files/changelog/zh/v<version>_<YYYY-MM-DD>.md`

    每份文件必须包含 `Version: v<version>`。工作流要求每种语言恰好有一份匹配文件，并按先中文、后英文的顺序合并为 GitHub Release 说明。

3. 按需更新 `README.md` 与发布说明中的安装示例和兼容性要求。
4. 通过 PR 将发布提交合入 `master`，分支名遵循 `YYYY-MM-DD_short-title`。例如 `chore: prepare v2.0.0-release.1 GitHub release --issue=#19` 只描述发布准备；提交和 PR 标题都不会触发发布。
5. 等待 CI 通过后合并。CI 会检查 PR 约定、TypeScript 类型和打包结果。合并到 `master` 会再次运行 CI，但不会发布。

被打 tag 的提交必须已包含当前的 Release 工作流，不要对仍带有旧发布流水线的提交打 tag。

## 为已合并的提交打 tag

请使用官方仓库 `infituit/opencode-acp`，不要使用 fork。下面示例中官方仓库的本地 remote 名为 `upstream`，如不同请替换。

```bash
git fetch upstream master --tags
git switch master
git merge --ff-only upstream/master

git status --short
git log -1 --oneline
node -p "require('./package.json').version"
```

确认工作区干净、发布提交正确且该提交的 CI 已通过，然后创建并推送附注 tag：

```bash
git tag -a v2.0.0-release.1 <merged-release-commit-sha> -m "ACP v2.0.0-release.1"
git push upstream refs/tags/v2.0.0-release.1
```

每次发布请替换示例中的版本号和提交 SHA。请使用本人已认证的 Git 凭据推送 tag。由其他工作流使用 `GITHUB_TOKEN` 推送的 tag 不会触发新的工作流运行，因此不要用该令牌自动化这一步。

Release 工作流只在推送 `v*` tag 时运行，没有手动触发入口，也不会根据合并标题发布。若需要将发布权限限制给维护者，请通过仓库 ruleset 限制谁可以推送发布 tag。

## 自动构建与发布

tag 触发后，工作流会依次执行：

1. 检出被打 tag 的提交，检查 tag 符合版本命名规范、等于 `v${package.json.version}`，且 `package-lock.json` 的两处版本一致。
2. 要求存在对应的中文与英文发布说明。
3. 使用 Node.js 22，通过 `npm ci --ignore-scripts` 安装依赖，并运行 `npm run typecheck` 与 `npm run check:package`。
4. 构建后运行 `npm pack --ignore-scripts`。
5. 为 tarball 生成 `SHA256SUMS`。
6. 针对已存在的 tag 创建 GitHub Release，附带发布说明和两个产物。`phase` 为 `release` 时创建正式 Release（如 `v2.0.0-release.1`），其他阶段创建预发布（如 `v2.1.0-beta.1`）；不再按是否包含连字符判断。

产物包括：

- `opencode-acp-<version>.tgz`：npm 包格式、已包含预构建 `dist/` 的包；不打包运行时依赖。
- `SHA256SUMS`：该 tarball 的 SHA-256 校验和。

发布使用仓库的 `GITHUB_TOKEN` 及 `contents: write` 权限，不需要 npm 令牌，也不依赖额外的发布 action。

## 确认发布并安装

在官方仓库的 **Actions** 页面查看 Release 运行结果，再打开对应的 GitHub Release，确认 tag、发布说明和两个产物。下载产物后可校验：

```bash
sha256sum -c SHA256SUMS
```

常规安装前，请先移除旧的 ACP npm 或本地开发插件配置，避免重复加载，然后安装对应 tag：

```bash
opencode plugin add github:infituit/opencode-acp#v2.0.0-release.1
```

该命令从 Git 安装，而不是使用 Release 中的 tarball。安装过程需要 Git 和 Node.js/npm，用于执行包的 `prepare` 构建；OpenCode 的 `plugin add` 不接受 tarball 目标。随后运行 `/reload`，开启新会话并使用 `/acp` 确认插件可用。跨不兼容版本升级前请备份现有状态；V1 的 JSON 状态不会因复制而迁移到 V2 存储。

## 失败与重试

- 工作流在创建 Release 之前失败时，先查看失败步骤。若是临时性故障且未创建 Release 或草稿，可重新运行失败的工作流。
- 若被打 tag 的源码需要修复，请合并一个带新版本号、对应发布说明的新发布提交，并使用新 tag。不要移动或强制推送已发布的版本 tag。
- 创建 Release 与上传产物是分开的 API 请求。若发布中途失败，重试前先检查 GitHub Releases（包括草稿）。工作流不会覆盖已有 Release 或产物，维护者需要明确处理残留草稿；不要通过删除已发布的 Release 来重试。
- tag 推送成功后，Git 源码即可被安装，早于 Release 构建完成。请等待发布成功后再对外宣布。

## 参考

- [GitHub Actions 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [从另一个工作流触发工作流](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [GitHub CLI：`gh release create`](https://cli.github.com/manual/gh_release_create)
- [OpenCode 插件安装](https://opencode.ai/v2/docs/plugins)
