# REQ - Issue Template Reorganization

- Task ID: `2026-10-23_issue-templates`
- Home Repo: `opencode-acp`
- Created: 2026-10-23
- Status: Done
- Priority: P1
- References: https://github.com/TencentBlueKing/bk-nodemgr/tree/master/.github/ISSUE_TEMPLATE
- Issue: https://github.com/infituit/opencode-acp/issues/1

## 1. Background & Problem Statement

The maintainer requested bk-nodemgr-style Issue forms as the first step in reorganizing this fork's `.github` directory. Existing forms refer to DCP, obsolete configuration/log paths, and a fixed list of old models.

## 2. Reproduction (if applicable)

Inspect `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, and `config.yml` on the starting branch.

## 3. Constraints & Non-Goals

- Use the reference's bilingual headings, submission checklists, and Bug / Feature / Discussion split.
- Adapt component categories, environment fields, and documentation links to ACP and `infituit/opencode-acp`.
- Preserve existing `bug` and `enhancement` labels; do not introduce a repository-wide label policy.
- Do not change workflows, funding, runtime code, versions, or repository settings.
- Keep the existing OpenCode 1.x support boundary; do not implement V2 support.

## 4. Acceptance Criteria (must be testable)

- [x] Three bilingual forms provide required checklists and issue-specific fields.
- [x] Bug reports collect reproduction steps, expected behavior, affected component, environment, and optional sanitized logs.
- [x] Documentation links target the maintenance fork; stale DCP names and paths are removed from these forms.
- [x] Blank Issues are disabled for general contributors.
- [x] YAML syntax, Issue Forms schema, and formatting checks pass for changed templates.

## 5. Proposed Approach (optional)

Change only `.github/ISSUE_TEMPLATE/*.yml` and this iteration's required devlog. Retain existing file names and YAML indentation. Roll back by reverting these files; no persisted state or application contract changes.
