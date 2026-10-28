# 发布流程

ACP 的构建与发布由 GitHub Actions 完成。维护者先准备发布提交并合并到 `master`，再对该提交推送版本 tag，由 tag 触发 [Release 工作流](../../.github/workflows/release.yml)。

GitHub Release 是发布源。Release 创建并上传产物成功后，通过 `needs: release` 调用 [Publish npm 工作流](../../.github/workflows/npm-publish.yml)，将同一 tarball 发布为公开 npm 包 `@infituit/opencode-acp`，不重新构建。工作流不会修改包版本、创建发布提交或推送 tag。

## 准备发布提交

1. 按[版本管理规范](../concepts/version_management.md)确定版本。将 `package.json` 的版本与 `package-lock.json` 中的两处版本号更新为目标版本。例如 `2.0.0-release.1` 对应 tag `v2.0.0-release.1`。
2. 为每种语言各新增一份发布说明：
    - `support-files/changelog/en/v<version>_<YYYY-MM-DD>.md`
    - `support-files/changelog/zh/v<version>_<YYYY-MM-DD>.md`

    每份文件必须包含 `Version: v<version>`。工作流要求每种语言恰好有一份匹配文件，并按先中文、后英文的顺序合并为 GitHub Release 说明。

3. 按需更新 `README.md` 与发布说明中的安装示例和兼容性要求。
4. 通过 PR 将发布提交合入 `master`，分支名遵循 `YYYY-MM-DD_short-title`。
5. 等待 CI 通过后合并。CI 会检查 PR 约定、TypeScript 类型和打包结果。合并到 `master` 会再次运行 CI，但不会发布。

被打 tag 的提交必须包含 Release 工作流。

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
6. 针对已存在的 tag 创建 GitHub Release，附带发布说明和两个产物。`phase` 为 `release` 时创建正式 Release（如 `v2.0.0-release.1`），其他阶段创建预发布（如 `v2.1.0-beta.1`）。

产物包括：

- `infituit-opencode-acp-<version>.tgz`：`@infituit/opencode-acp` 的 npm 包，已包含预构建 `dist/`；不打包运行时依赖。早期未使用 scope 的 GitHub Release 产物名为 `opencode-acp-<version>.tgz`，不能直接用于新的自动 npm 发布流程。
- `SHA256SUMS`：该 tarball 的 SHA-256 校验和。

GitHub Release 使用仓库的 `GITHUB_TOKEN` 及 `contents: write` 权限。该令牌创建的 Release 不会再次触发 `release: published` 工作流，因此 npm 发布使用同一次运行中的可复用工作流调用，而不是监听 Release 事件。

## npm 自动发布配置

在 npm 的 `@infituit/opencode-acp` 包 Settings 中配置 **Trusted Publisher → GitHub Actions**：

- Organization or user：`infituit`
- Repository：`opencode-acp`
- Workflow filename：`release.yml`（调用方工作流，不是 `npm-publish.yml`）
- Environment name：留空
- Allowed actions：启用直接 `npm publish`

npm 以调用方工作流身份校验 OIDC。调用方与被调用方均授予发布 job `id-token: write`，仅允许官方仓库运行；无需配置 `NPM_TOKEN`。发布使用 GitHub-hosted runner、Node.js 22 和 npm 11，以满足 Trusted Publishing 的版本要求。新建的 Trusted Publisher 配置须在两天内完成首次成功发布，否则需要重新创建。

Publish npm 工作流下载指定 Release 的 tarball 和 `SHA256SUMS`，验证校验和、包名及版本后执行 `npm publish --ignore-scripts --access public`。发布过程中不检出源码、不安装包依赖、不重新执行构建脚本。

npm dist-tag 按版本中的 `phase` 选择：`release` → `latest`，其他阶段转为小写，例如 `alpha` → `alpha`、`beta` → `beta`。预发布不会更新 `latest`。已手动发布的 `2.0.0-alpha.1` 不会被覆盖；后续使用新版本和新 tag。

## 确认发布并安装

在官方仓库的 **Actions** 页面确认 Release 和后续 npm 发布 job 均成功，再打开对应的 GitHub Release，确认 tag、发布说明和两个产物。下载产物后可校验：

```bash
sha256sum -c SHA256SUMS
```

常规安装前，请先移除旧的 ACP npm、Git 或本地开发插件配置，避免重复加载，然后安装对应 npm 版本：

```bash
opencode plugin add @infituit/opencode-acp@2.0.0-release.1
```

也可使用 `@alpha` 跟随 Alpha 渠道，或在正式版本发布后使用 `@latest`。npm 包包含预构建 `dist/`，安装时无需从 Git 源码构建。Git 安装方式仍保留，但会执行 `prepare` 构建；OpenCode 的 `plugin add` 不接受 tarball 目标。随后运行 `/reload`，开启新会话并使用 `/acp` 确认插件可用。跨不兼容版本升级前请备份现有状态；V1 的 JSON 状态不会因复制而迁移到 V2 存储。

## 失败与重试

- 工作流在创建 Release 之前失败时，先查看失败步骤。若是临时性故障且未创建 Release 或草稿，可重新运行失败的工作流。
- 若被打 tag 的源码需要修复，请合并一个带新版本号、对应发布说明的新发布提交，并使用新 tag。不要移动或强制推送已发布的版本 tag。
- 创建 Release 与上传产物是分开的 API 请求。若发布中途失败，重试前先检查 GitHub Releases（包括草稿）。工作流不会覆盖已有 Release 或产物，维护者需要明确处理残留草稿；不要通过删除已发布的 Release 来重试。
- GitHub Release 已成功但 npm 发布失败时，修复 OIDC 配置或临时故障后，在该次 Release 运行中仅重新运行失败的 job。不要重新创建 Release 或移动 tag。npm 不允许重复发布相同包名和版本；如果版本已经存在，先核对实际发布结果，不要盲目重试。
- tag 推送成功后，Git 源码即可被安装，早于 Release 构建完成。请等待 GitHub Release 与 npm 发布均成功后再对外宣布。

## 参考

- [GitHub Actions 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [从另一个工作流触发工作流](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [GitHub CLI：`gh release create`](https://cli.github.com/manual/gh_release_create)
- [OpenCode 插件安装](https://opencode.ai/v2/docs/plugins)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
