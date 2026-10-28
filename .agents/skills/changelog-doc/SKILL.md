---
name: changelog-doc
description: Use when writing ACP versioned changelog or release notes under support-files/changelog/{zh,en} from release ranges, diffs, PR facts, or issue summaries. Trigger on "changelog", "发布说明", "版本变更记录", "Full Changelog", or preparing bilingual release notes. Not for ordinary README edits or PR descriptions.
---

# Changelog 文档编写

编写 ACP 双语发布说明，说明用户可感知的变化、兼容性影响和升级动作。GitHub Actions 将中文与英文文件合并为 GitHub Release 正文。

## 先读

- `docs/concepts/version_management.md`：目标版本格式。
- `docs/developer/release.md`、`.github/workflows/release.yml`：消费契约。
- `support-files/changelog/README.md` 与最近的双语版本文件：本地格式和术语。
- 用户指定的 tag、commit、PR、Issue，以及必要的实现上下文。

纯 PR 描述使用 `opencode-acp-create-github-pr`；版本字段对齐使用 `release-version-alignment`。不要把维护者发布教程写成某版本的用户发布说明。

## 1. 确定发布窗口

确认完整版本、日期、起始发布版本或提交、目标提交、语言和受众。默认同时生成中文与英文，技术名词使用 `ACP`、`OpenCode`、`Plugin`、`GitHub Release` 等稳定名称。

证据优先级：用户确认资料 → 实际发布范围 diff → 既有 changelog → PR/Issue → 必要代码。明确区分“用户提出的目标”和“已经实现的行为”。

以已确认的起止提交为范围核对实际变更；tag 尚未创建时使用已确认的目标提交，不为整理说明而创建 tag。不逐条拼接 raw commit message，不把 merge/revert/cherry-pick 的中间状态重复算作发布结果，不把未进入范围的能力写进正文。

起点、终点或重要兼容性不明确时，报告给编写者并只提供对话草稿；不要猜版本号、日期、比较范围或升级保证，也不要写入最终发布路径。

## 2. 先整理影响和动作

按需要覆盖：

- 插件能力、压缩/恢复、消息与会话、存储/配置、安装与分发的影响范围。
- 所需 OpenCode/Node.js 版本、安装入口、升级或重新加载动作。
- 配置和持久化状态是否兼容，是否需要备份、迁移或新会话。
- breaking changes、已确认限制及可用规避方式。

每条描述用户结果；同一结果跨多个模块时合并为一条。只在影响使用、升级或维护时纳入内部重构。性能、可靠性或兼容性结论必须有对应证据，不能由变更标题推导。

读者需要的限制必须保留；编写者的核实清单、证据置信度、待发布状态和审查请求留在对话中，不放入正文、脚注或 sidecar 文件。不要通过改成肯定句来掩盖未知事实。

## 3. 使用版本化双语文件

```text
support-files/changelog/zh/v<version>_<YYYY-MM-DD>.md
support-files/changelog/en/v<version>_<YYYY-MM-DD>.md
```

`<version>` 不重复带 `v`，例如 `v2.0.0-release.1_2026-10-27.md`。每种语言只保留一份该版本文件，文件名、标题日期与版本一致。不覆盖历史说明，不向单个 `release.md` 持续追加版本。

正文按以下顺序，删除无事实支撑或不适用的可选章节；双语含义和风险必须一致。标题必须包含 `Version: v<version>`，供既有检查与工作流识别。

```markdown
## [Version: v2.1.0-beta.1] - YYYY-MM-DD

Full Changelog: [from-tag...to-tag](https://github.com/infituit/opencode-acp/compare/from-tag...to-tag)

> 重要提示：仅在有 breaking change、强制操作或重大升级风险时保留。

**发布范围**

- [受影响的 ACP 能力或分发入口]

**新增功能**

- [用户可使用的新能力]

**功能优化**

- [已有能力的变化]

**缺陷修复**

- [问题现象、影响对象与修复结果]

**兼容性与升级前置条件**

- [OpenCode/Node.js 要求、配置和状态兼容性、升级动作]

**已知问题**

- [已确认的限制、影响范围和规避方式]
```

以上为模板，不是可直接发布的具体版本正文。至少包含发布范围、一个变化分类，以及与该版本有关的兼容性/前置条件；有升级影响时先说明重要提示，再展开变化。

英文文件采用相同顺序和事实，用 `Release scope`、`New features`、`Improvements`、`Fixes`、`Compatibility and upgrade prerequisites`、`Known issues` 等对应标题。

## 4. 比较链接与首次发布

`Full Changelog` 的文字和 URL 必须使用同一组起止引用，仓库取当前确认的官方仓库，不盲目沿用模板地址。目标 tag 未创建但版本和提交已确认时，可拟定链接，并在对话中交代发布前需核验，不在正文插入核验状态或声称链接已可用。

首次发布没有前序 tag 时，先向用户确认采用的起始提交或发布基线。可以使用已确认的 commit range；不要虚构旧 tag。若用户明确不采用比较链接，可省略它并保留已确认的变更范围，不伪装完整的历史比较。

## 5. 确认与检查

先交付双语草稿，关键缺口单列给编写者；用户确认内容且关键事实足够后，再写入正式文件。

- 检查版本格式、双语文件名和日期、标题中的 `Version: v<version>`。
- 核对比较范围、读者影响、升级动作与术语，确保两种语言一致。
- 使用标准 Markdown，不依赖自定义 HTML、脚本或私有渲染器。
- 运行针对目标文件的既有格式检查和 `git diff --check`。
- 发布版本发生变化时，与 `release-version-alignment` 配合检查 package/lock 和安装引用。

交付双语文件路径、发布范围和比较链接；未决事项单独列出，不写入发布说明。
