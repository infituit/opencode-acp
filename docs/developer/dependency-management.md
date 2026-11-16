# Dependency management policy

This policy is for maintainers and contributors updating ACP's npm dependencies and GitHub Actions references.

## Project policy

Dependency upgrades are planned manually when needed for security fixes, bug fixes, required capabilities, or supported-toolchain maintenance. An upstream release alone is not a reason to open an upgrade PR. Each change must identify its purpose, compatibility impact, verification, and rollback path.

ACP does not use dependency bots to create upgrade PRs automatically:

- **Version updates:** every entry in [`.github/dependabot.yml`](../../.github/dependabot.yml) sets `open-pull-requests-limit: 0`. This takes effect when the configuration reaches the default branch.
- **Security update PRs:** maintainers must keep **Dependabot security updates** disabled in the repository's **Settings → Advanced Security**. This is a separate setting; the YAML limit does not disable security update PRs.
- **Vulnerability detection:** keep **Dependency graph** and **Dependabot alerts** enabled. Disabling automatic PRs must not disable vulnerability discovery or replace assessment of reported vulnerabilities.
- **Existing PRs:** review them individually and retain or close them according to whether the update is still needed. Disabling new PRs does not resolve existing ones.

Keep the configuration entries as an explicit record of this policy. `schedule` is required by Dependabot's configuration format; it does not authorize PR creation when the limit is `0`. Re-enabling automatic PRs or introducing another dependency bot requires a separate maintainer decision. Automatic PR creation and automatic merging are separate decisions.

## Dependency scope

| Ecosystem        | Directory | Source of truth                                                                         |
| ---------------- | --------- | --------------------------------------------------------------------------------------- |
| `npm`            | `/`       | [`package.json`](../../package.json) and [`package-lock.json`](../../package-lock.json) |
| `github-actions` | `/`       | Action references in [`.github/workflows/`](../../.github/workflows/)                   |

Use `/` for the GitHub Actions entry, not `/.github/workflows`. New entries must also set `open-pull-requests-limit: 0` unless maintainers explicitly change the policy.

### npm and compatibility boundaries

- Use npm and preserve `package-lock.json`. Update dependency declarations and the lockfile together when declarations change; do not delete the lockfile or switch package managers to resolve an upgrade.
- Limit changes to the selected dependency and necessary transitive updates. Do not combine unrelated upgrades or regenerate the entire dependency tree without a specific need.
- Preserve existing version-range conventions unless the change requires a different constraint. Do not substitute `latest`, Git branches, or local `file:` dependencies for a published runtime requirement.
- ACP 2.x targets OpenCode `>=2.1.4 <3`. Review `@opencode/plugin` and `@opencode/ai` together, including the plugin's runtime and peer dependency declarations. Do not widen the supported host range or add OpenCode 1.x compatibility as an incidental dependency update.
- The current [CI workflow](../../.github/workflows/ci.yml) uses Node.js 22. Check package engine requirements against that baseline; a newer `@types/node` version is not evidence that newer runtime APIs are available.
- Check ESM compatibility and the published package, not only TypeScript types. Preserve the intentional bundling exceptions in [`tsup.config.ts`](../../tsup.config.ts) unless the update includes evidence that they are no longer needed.
- For a new dependency, explain why Node.js built-ins and existing dependencies are insufficient, and review its license, maintenance, transitive dependencies, and install scripts. Preserve applicable notices in [`NOTICE`](../../NOTICE).

## Manual upgrade workflow

1. Identify the affected dependency and resolved version. Read upstream release notes or the security advisory and choose a target version that addresses the actual need.
2. Review breaking changes, Node.js requirements, peer dependencies, ESM exports, and install scripts. Group dependencies only when their compatibility constraints require a coordinated update.
3. Use a targeted npm install for the chosen package and version, preserving its dependency section and intended version range. Review both `package.json` and `package-lock.json`; do not use a bulk update to fix one dependency.
4. Verify a clean install and the existing package checks using the CI Node.js baseline:

    ```bash
    npm ci --ignore-scripts
    npm run typecheck
    npm run check:package
    ```

    `npm ci` requires the manifest and lockfile to agree and does not update either file. `--ignore-scripts` skips install lifecycle scripts; `check:package` explicitly builds ACP and verifies the package. Review any required dependency install script before running it rather than silently dropping the flag.

5. Check formatting for changed files with the repository's Prettier configuration. Run focused tests or a host smoke test for behavior affected by the dependency. For host integration changes, verify plugin loading and the affected tool or command on a supported OpenCode version; typechecking and packaging alone do not establish runtime compatibility.
6. In the PR, record old and new versions, the reason and upstream links, compatibility risks, actual verification results, and rollback steps. Do not describe an upgrade as verified solely because it is a patch or minor release.

For GitHub Actions updates, review the action's release notes, inputs, outputs, permissions, and runner requirements. Change only the intended references and verify the affected workflow; npm checks alone do not validate an action upgrade. Do not broaden workflow permissions as an incidental version bump.

## Security findings

Assess Dependabot alerts and `npm audit` findings by advisory, resolved dependency path, affected version, exposure, and available fix. Distinguish runtime dependencies from build tooling, but do not dismiss a build-time vulnerability solely because it is a development dependency.

Prefer a targeted update of the affected direct dependency or its parent. Review all changes from `npm audit fix`; do not apply `npm audit fix --force` as a blanket remedy, since it can change declared ranges and introduce breaking upgrades. A transitive override needs a documented compatibility reason and a removal condition, not just a passing audit count.

If no compatible fix is available, record the exposure, mitigation, and condition for revisiting the finding in the tracking issue. Disabling security update PRs is not a reason to leave a finding unassessed.

## Rollback

Keep related dependency declarations, lockfile changes, and required code adaptations in the same reviewable change. Before release, revert that change and verify a clean install and package checks. If the change has already shipped, prepare a corrective release with a new version; do not move published tags or overwrite an npm version. Follow the [release workflow](release.md).

## Confirm the bot policy

After the configuration is merged into the default branch:

- Confirm both ecosystem entries retain a zero PR limit, including any newly added entries.
- In repository settings, confirm **Dependabot security updates** is disabled while **Dependency graph** and **Dependabot alerts** remain enabled.
- If new bot PRs still appear, check their author, update type, target directory, and the effective default-branch configuration. Inspect the corresponding Dependabot update logs under **Insights → Dependency graph → Dependabot**; do not infer the trigger from the PR's creation time alone.
- Review already-open dependency PRs separately. PR checks evaluate a proposed change; they do not create Dependabot upgrade PRs.

## References

- [Dependabot configuration options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Configure Dependabot security updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci)
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit)
