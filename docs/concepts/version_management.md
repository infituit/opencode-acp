# 版本管理

版本命名用于描述 ACP 发布包的版本阶段、迭代序号和可选标记。

## 格式

```text
v{major}.{minor}.{patch}-{phase}.{serial}[-{mark}]
```

`package.json` 的 `version` 字段不带前导 `v`，即 `{major}.{minor}.{patch}-{phase}.{serial}[-{mark}]`。Git tag 与 GitHub Release 使用带 `v` 的完整版本名。

## 正则

```text
^v(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)-(?P<phase>[a-zA-Z]+)\.(?P<serial>\d+)(?:-(?P<mark>[a-zA-Z0-9][a-zA-Z0-9.-]*))?$
```

## 字段

| 字段     | 说明                                   | 示例                       |
| -------- | -------------------------------------- | -------------------------- |
| `major`  | 主版本号                               | `2`                        |
| `minor`  | 次版本号                               | `0`                        |
| `patch`  | 修订版本号                             | `0`                        |
| `phase`  | 发布阶段                               | `alpha`、`beta`、`release` |
| `serial` | 当前阶段内的迭代序号                   | `1`                        |
| `mark`   | 可选标记，用于补充测试、渠道或临时标识 | `test`                     |

## 迭代规则

- `major`、`minor`、`patch` 共同描述基础版本。
- `phase` 表示当前发布阶段。`release` 表示正式版本，`alpha`、`beta` 等其他阶段表示预发布。
- `serial` 在同一基础版本和阶段内递增，例如 `v2.0.0-alpha.1` 之后是 `v2.0.0-alpha.2`。
- `mark` 为可选字段，仅用于补充说明，不参与基础版本定义。
- 不带 `phase.serial` 的版本（如 `v2.0.0`）不符合本规则，不能用于发布。

## Tag 规则

Git tag 直接使用完整版本名，并与 `package.json` 的版本（加前导 `v`）、`package-lock.json` 的版本、变更日志文件名和 GitHub Release 名称保持一致。

## 示例

| 版本                 | major | minor | patch | phase     | serial | mark   |
| -------------------- | ----- | ----- | ----- | --------- | ------ | ------ |
| `v2.0.0-release.1`   | `2`   | `0`   | `0`   | `release` | `1`    | -      |
| `v2.1.0-beta.3`      | `2`   | `1`   | `0`   | `beta`    | `3`    | -      |
| `v2.1.0-beta.3-test` | `2`   | `1`   | `0`   | `beta`    | `3`    | `test` |

## GitHub 预发布判定

Release 工作流按 `phase` 决定 GitHub Release 类型：`phase` 为 `release` 时创建正式 Release，其他阶段创建预发布。

## 校验位置

- Release 工作流在发布前校验 tag 符合上述正则，并与 `package.json`、`package-lock.json` 的版本一致。
- `scripts/ci/check-pr.sh` 在版本变化时要求中英文变更日志包含 `Version: v<version>`。

## 说明范围

本文仅描述版本命名方法，不定义版本比较语义或兼容性保证。发布步骤见[发布流程](../developer/release.md)。
