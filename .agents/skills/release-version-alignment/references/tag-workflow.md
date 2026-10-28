# 发布 Tag

## 确认最终发布提交

1. 核对官方仓库与当前默认分支，获取最新提交和 tags。
2. 找到已合入默认分支的最终发布提交，而不是第一个标题包含 release/version 的提交。
3. 若版本对齐、说明或安装引用有补漏 PR，等待它们合入后，重新确认目标提交。
4. 确认目标提交的 package/lock 版本、双语 changelog 和 Release 工作流一致，相关 CI 已通过。
5. 核对版本、目标 commit、所在分支、CI 结果及 tag 是否已存在。

tag 必须使用 `v{major}.{minor}.{patch}-{phase}.{serial}[-{mark}]`。不要根据 PR 标题推断应发布的阶段。GitHub Release 的正式/预发布属性由 `phase` 决定。

## 推送 Tag

- 使用维护者的 Git 凭据向官方仓库推送附注 tag，触发 GitHub Actions 构建和发布。
- 使用 `GITHUB_TOKEN` 从另一工作流推送 tag 不会触发 Release 工作流。
- tag 推送后即可通过 Git 安装，但应等待 Release 工作流成功后再宣布发布。

## 已存在的 tag 或失败的发布

已存在的 tag 指向目标提交时，先检查 Release 和 Actions 状态，不重复创建或推送。若 tag 指向别处、存在未完成草稿或需要修复被打 tag 的源码，停止并报告实际状态。

默认通过新版本、新提交和新 tag 修复。不要自动删除、移动或强推 tag，不通过删除已发布 Release 来重试。临时性失败的重跑也应先检查是否已经创建 Release 或草稿，避免重复写入。
