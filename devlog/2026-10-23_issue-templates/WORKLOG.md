# WORKLOG - Issue Template Reorganization

- Task ID: `2026-10-23_issue-templates`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-10-23

## 1. Summary

Adapted the bk-nodemgr Issue submission flow to the ACP maintenance fork. Readers are users reporting defects or requesting changes; maintainer process notes remain in this devlog rather than the public forms.

## 2. Change Log

- Issue: https://github.com/infituit/opencode-acp/issues/1 (`enhancement`).
- The maintainer approved enabling Issues on `infituit/opencode-acp`, creating the linked Issue, committing these six files, pushing the feature branch, and creating a PR to the fork's `master` with `Fixes #1`. No other repository setting changes or PR merge are authorized.
- `.github/ISSUE_TEMPLATE/bug_report.yml` — bilingual checklist and ACP diagnostic fields.
- `.github/ISSUE_TEMPLATE/feature_request.yml` — bilingual checklist, problem, solution, category, and use case.
- `.github/ISSUE_TEMPLATE/discussion.yml` — discussion/proposal entry for ideas without a settled implementation.
- `.github/ISSUE_TEMPLATE/config.yml` — structured submission and fork documentation links.

## 3. Design & Implementation Notes

- Reference: `TencentBlueKing/bk-nodemgr/.github/ISSUE_TEMPLATE/{bug_report,feature_request,discussion,config}.yml`.
- Preserve ACP's existing `bug` / `enhancement` labels instead of importing Node Manager's label taxonomy. Discussions do not require a new label.
- Reference `README.md`, `README.zh-CN.md`, `CONFIGURATION.md`, and `lib/logger.ts` for support scope and log/config paths.
- Do not advertise an unverified private security-reporting endpoint or copy the unrelated BlueKing community link.
- Allow intermittent bug reports when reproduction frequency and triggering conditions are described, rather than requiring a false claim of reliable reproduction.

## 4. Testing & Verification

- **PASS**: All four YAML files parse with Ruby/Psych and PyYAML.
- **PASS**: The three forms validate against SchemaStore's `github-issue-forms.json`, retrieved through webfetch. The chooser configuration passes explicit checks for supported keys, a false blank-Issue setting, and valid fork contact links.
- **PASS**: Unique field IDs and labels, required checklist options, matching Bug/Feature categories, optional logs, existing bug/enhancement labels, and absence of obsolete DCP references.
- **PASS**: `prettier --check .github/ISSUE_TEMPLATE/*.yml devlog/2026-10-23_issue-templates/*.md`.
- **PASS**: `git diff --check`.
- **BLOCKED**: `npm run typecheck` — missing `@types/node` (TS2688).
- **BLOCKED**: `npm run build` — `tsup` is not installed. The build's clean step ran; Git reports no tracked build-output changes.
- **BLOCKED**: `npm test` — the `tsx` package is not installed, so the test files do not execute.
- **FAIL, outside this change**: `npm run format:check` reports 479 existing files with style issues; the changed files pass the targeted check.
- No runtime source or test files changed, so the repository's source/test dual-agent review gate does not apply to this template-only change.
- **PASS**: `bash scripts/ci/check-pr.sh 2026-10-23_issue-templates origin/master` after fetching the maintenance fork's latest `master`.
- **PASS**: Verified that Issues are enabled and Issue #1 matches the confirmed title, body, and label.
- No GitHub Issue chooser preview was performed on the default branch; the new forms will be available after a human merges the PR.

## 5. Risk Assessment & Rollback

- Low risk: only Issue submission metadata changes; blank Issues become maintainer-only under GitHub's chooser rules.
- No runtime code, persisted state, internal DCP tags, or package version changes.
- Revert the affected templates and devlog to roll back.
