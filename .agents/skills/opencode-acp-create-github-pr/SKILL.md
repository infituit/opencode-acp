---
name: opencode-acp-create-github-pr
description: Use when preparing, creating, updating, replacing, or splitting a GitHub Pull Request in the opencode-acp repository, including plugin, compression, persistence, configuration, documentation, CI, release, and cross-layer changes. Trigger for “准备 PR”, “create PR”, “submit pull request”, “替代 PR”, or “提交 PR”.
---

# Create an opencode-acp Pull Request

Prepare and deliver pull requests for `opencode-acp`. Read the repository rules and current GitHub templates/workflows before drafting.

This skill owns the agent execution flow and remote-write safety. It does not replace domain-specific investigation, code review, runtime verification, or release procedures.

For release preparation and package/lock/changelog alignment, use `release-version-alignment`. For bilingual release notes, use `changelog-doc`. Version naming lives in `docs/concepts/version_management.md`; release steps live in `docs/developer/release.md`.

## Operating modes

Choose the mode from the user's wording before any remote write:

| User intent                                        | Mode          | Default behavior                                                                                 |
| -------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| “准备”“draft”“整理 PR”“帮我看能不能提”             | `preflight`   | Local reads, existing remote metadata reads, and complete draft output; no push or GitHub writes |
| “创建/提交 PR” with a confirmed Issue and branch   | `create`      | Draft first, then separately confirm each remote write                                           |
| “更新 PR”“补充描述”“修标题”                        | `update`      | Read the existing PR, draft the complete edit, then confirm that specific edit                   |
| “替代/恢复旧 PR”“replaces”                         | `replacement` | Preserve old facts and head context; migrate them into the current repository format             |
| Multiple independent behaviors or partial delivery | `split`       | Keep each PR reviewable and use non-closing Issue relations until the work is complete           |

`preflight` is the default when intent is ambiguous. Approval of a draft is not authorization to push, create or edit an Issue/PR, change labels, assign reviewers, or modify milestones.

## 1. Read repository rules and determine scope

Before drafting, read the current versions of:

- `AGENTS.md` and any nearest scoped `AGENTS.md` for changed paths
- `.github/CONTRIBUTING.md`, if present
- PR templates in all supported locations:
    - `.github/PULL_REQUEST_TEMPLATE.md`
    - `.github/pull_request_template.md`
    - `.github/PULL_REQUEST_TEMPLATE/`
    - `docs/PULL_REQUEST_TEMPLATE.md`
    - `PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/` and `.github/ISSUE_TEMPLATE/config.yml`
- `.github/workflows/` workflows affecting pull requests, releases, labels, or validation
- labeler files such as `.github/labeler.yml` or `.github/labeler.yaml`, if present
- repository developer/contribution documentation, if present

For code changes, use the repository's normal routing and relevant local skills. Do not treat this PR skill as a replacement for code review or runtime-specific verification.

Resolve the canonical comparison base from remote URLs, not remote names:

```bash
git remote -v
git branch -vv
git fetch --prune <canonical-remote> <base-branch>
git merge-base HEAD <canonical-remote>/<base-branch>
```

Identify the canonical upstream repository from the remote URL. Do not assume that a remote named `origin` is canonical, and do not use a fork's default branch merely because it is named `origin`. If no canonical base can be identified, stop and ask for the target remote and branch.

Use a freshly fetched canonical base when remote refresh is authorized. In `preflight`, do not pretend that a stale tracking ref is current; report whether the base was refreshed and, if not, the boundary of the analysis.

Capture:

- current branch and tracking status;
- canonical repository, remote, and target base;
- fork/direct-push topology and whether the branch is already pushed;
- merge base and commit range;
- changed paths and line counts;
- actual behavior changes and affected areas;
- existing Issue/PR references;
- unrelated dirty-worktree changes that must remain outside the PR scope.

If the user provides an explicit commit range, analyze that range rather than silently analyzing the entire branch.

## 2. Apply the Issue policy

The PR should be associated with an Issue. Use this order:

1. Reuse an Issue explicitly provided by the user after verifying it.
2. Search for an open Issue that clearly covers the same behavior or maintenance scope.
3. For routine `.github/**` or other maintenance work, look for the current open `[DAILY]` or umbrella Issue and reuse it when it is the project's established tracking mechanism. Do not create a feature Issue merely to satisfy PR bookkeeping or title formatting.
4. Create an Issue only when no suitable Issue exists and the user separately authorizes that remote write.
5. Choose the Issue template that matches the actual scope:
    - `bug_report.yml` for reproducible defects;
    - `feature_request.yml` for defined user-facing features or improvements;
    - `discussion.yml` for unresolved direction, design, or proposal work.

Issue search is evidence gathering, not permission to bind an Issue. If multiple Issues are plausible, show the candidates and the matching facts, then ask which one to use. Do not invent reproduction steps, environment details, logs, acceptance criteria, impact, or affected components.

Preserve the selected Issue form's title prefix, labels, and field semantics. In this repository, verify the current bilingual forms rather than hard-coding them; the currently observed prefixes are `[Bug]:`, `[FEATURE]:`, and `[IDEA]`, with `bug` and `enhancement` labels on the first two forms. Blank Issues are currently disabled, so if a new Issue is necessary, use a matching repository template instead of an unstructured Issue.

Use Issue relation keywords according to the actual Issue scope:

- use `refs` or `related to` for routine maintenance, umbrella tracking, replacement PRs, and partial delivery;
- use `closes`, `fixes`, or `resolves` only when the Issue is genuinely completed by this PR and the user confirms the intended close-on-merge behavior;
- never use a closing keyword solely because an Issue exists.

## 3. Build the verification matrix

Build verification from the changed paths and actual current HEAD. Only claim a check as passed after running it against the analyzed commit. Historical PR results, old commit results, and old CI results are evidence about history, not current validation.

For this repository, use the following as a starting matrix and adjust it to the actual diff:

| Changed area                                                                            | Relevant verification                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript source, `index.ts`, `lib/**`                                                 | `npm run typecheck`                                                                                                                                                               |
| Package metadata, exports, dependencies, build behavior                                 | `npm run check:package`                                                                                                                                                           |
| Compression, message transforms, hooks, persistence, prompts, GC, or lifecycle behavior | `npm run build`, then the smallest relevant E2E scenario(s); use `scripts/e2e/README.md` to select scenarios                                                                      |
| Cross-hook or persistence behavior                                                      | `npm run build` plus the relevant isolated E2E scenario(s); use `./scripts/e2e/run-e2e.sh` rather than the user's real OpenCode state                                             |
| `scripts/e2e/**` or E2E scenarios                                                       | the affected scenario(s), or the full E2E suite when the runner or shared fixture changes                                                                                         |
| `scripts/ci/check-pr.sh`, `.github/**`, branch/release rules                            | `./scripts/ci/check-pr.sh <head-branch> <base-ref>` when the required refs are available, plus manual workflow/YAML inspection                                                    |
| `package.json` version change                                                           | `./scripts/ci/check-pr.sh <head-branch> <base-ref>`; confirm both `support-files/changelog/en` and `support-files/changelog/zh` contain the new version as required by the script |
| Documentation-only changes                                                              | the relevant format or link checks if available; do not claim runtime checks unless the changed docs affect executable examples or contracts                                      |

The repository CI currently runs `npm ci --ignore-scripts`, `npm run typecheck`, and `npm run check:package` on Node 22, with PR convention checks against the target base. Release runs only on pushed `v*` tags, validates version naming and package/lock/changelog alignment, then builds GitHub-only release assets. It does not publish to npm or create tags. Read the current workflows before relying on this map; it is not proof that checks ran.

For E2E work, the runner is isolated under `/tmp/acp-e2e`; it requires `opencode`, `bun`, `node`, and `curl`. A normal run builds first; use `SKIP_BUILD=1` only when the build was already run against the same current HEAD.

For every unrun check, state:

- exact command or manual check not run;
- reason it was not run;
- what boundary remains unverified.

## 4. Draft the current PR body

Always start from the current repository PR template if one exists. Do not copy an old `Summary/Changes/Motivation` body as the structure. If no PR template exists, use this fallback structure and keep it bilingual where the repository convention calls for bilingual reader-facing text:

```markdown
## 变更概述 / Summary

<!-- What changed and why. -->

## 变更范围 / Changes

- ...

## 影响区域 / Affected Areas

- ...

## 验证 / Verification

- [x] `command` — result
- [ ] `command` — not run because ...

## 风险与回滚 / Risks & Rollback

- Risk: ...
- Rollback: ...

## Issue 关系 / Issue Relation

Related: #<issue-number>
```

Labels do not replace `Affected Areas`. Include the actual plugin surface, runtime behavior, persistence/configuration implications, package/release implications, or documentation impact as applicable.

For a replacement PR:

- migrate facts into the current template or fallback structure;
- preserve the original Issue, head/commit context, risk notes, test notes, and `Replaces #<old-pr>` reference;
- do not reuse historical test results as current validation;
- state explicitly when tests were not rerun on the current HEAD;
- preserve an intentional `[WIP]` marker unless the user asks to remove it, and report any title-lint concern rather than silently changing it.

## 5. Validate the title and draft output

Read current title rules before choosing a title. If a workflow or contribution document defines a title regex, follow it exactly. Keep Issue title prefixes separate from PR title rules.

If no repository PR title rule is found, use a concise English-compatible conventional title with the confirmed Issue relation, for example:

```text
<type>: <english description> --issue=#<issue-number>
```

Use the repository's actual conventions when recent PRs or documentation establish a different format. Do not invent a title rule merely because the fallback example exists.

Before any remote write, show all of the following:

- mode;
- scope, canonical base, and head;
- merge base and commits analyzed;
- Issue number, title, state, and relation;
- exact PR title;
- complete current-template or fallback PR body;
- predicted path labels, clearly marked as predictions;
- affected areas;
- verification matrix with actual results and unverified items;
- risks and rollback;
- remote actions still pending.

In `preflight`, end with:

```text
No GitHub writes performed
```

Do not push merely to make a draft complete.

## 6. Execute remote actions through separate gates

Treat each action as a separate confirmation gate:

1. push the branch to the intended fork or same-repository remote;
2. create or edit an Issue;
3. create or edit the PR;
4. change labels, assignees, reviewers, or milestones.

Confirmation to review the draft does not authorize all four actions. For fork PRs, use `head=<fork-owner>:<branch>` and target the canonical repository. For same-repository branches, use explicit repository, base, and head arguments.

Use body files for multiline GitHub content:

```bash
gh pr create --repo <owner>/<repo> --base <base> --head <head> --title "..." --body-file <body-file>
gh pr edit <pr-number> --repo <owner>/<repo> --body-file <body-file>
```

Do not use `gh api -f body=@file`; that can submit the literal path. Do not treat `--dry-run` as an absolute no-write guarantee when the command may push or mutate remote state.

After each successful write, read back the resource:

```bash
gh issue view <issue-number> --repo <owner>/<repo> --json number,title,body,labels,state,url
gh pr view <pr-number> --repo <owner>/<repo> --json number,title,body,baseRefName,headRefName,url,state,labels
```

If a command fails after possibly creating a resource, query its state before retrying. Never blindly repeat an Issue or PR creation request.

## Output contract

Return a concise delivery report containing:

- Issue URL/number and relation;
- PR URL, base, head, title, and state;
- changed scope and affected areas;
- verification commands/results and untested items;
- risks and rollback;
- observed versus predicted labels;
- remote actions performed or skipped.

For drafting-only work, return the complete Issue/PR drafts and verification matrix. Do not fabricate URLs, successful-creation claims, or remote-write implications.

## Common failure modes

- Creating a duplicate Issue instead of reusing a matching open or `[DAILY]`/umbrella Issue.
- Using `closes` for routine, umbrella, replacement, or partial work.
- Binding an Issue inferred from branch names or commit messages without confirmation.
- Reusing a stale PR body or old test result without mapping it to current HEAD.
- Treating predicted path labels as actual labels.
- Reporting typecheck, package verification, E2E, changelog checks, or manual workflow validation that did not run.
- Hand-editing generated output or claiming generated artifacts were validated without running the relevant build.
- Treating one confirmation as permission to mutate multiple GitHub resources.
- Retrying `gh` creation after an ambiguous failure without checking resource state.
- Assuming the repository has a PR template, title lint, labeler, or contribution guide without checking the current tree.
