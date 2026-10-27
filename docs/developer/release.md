# Release process

ACP releases are built and published by GitHub Actions. Maintainers prepare a
release commit, merge it into `master`, and push a version tag pointing to that
commit. The tag push triggers the [Release workflow](../../.github/workflows/release.yml).

Releases are distributed through GitHub only. Neither CI nor the release workflow
publishes to npm, changes package versions, creates release commits, or pushes tags.

## Prepare the release commit

1. Update `package.json` and both version fields in `package-lock.json` to the
   intended version. For example, `2.0.0` corresponds to the tag `v2.0.0`.
2. Add one release note file per language:
    - `support-files/changelog/en/v<version>_<YYYY-MM-DD>.md`
    - `support-files/changelog/zh/v<version>_<YYYY-MM-DD>.md`

    Each file must contain `Version: v<version>`. The workflow requires exactly one
    matching file per language and combines Chinese then English notes into the
    GitHub Release description.

3. Update installation examples and compatibility requirements in `README.md` and
   the release notes as needed.
4. Submit the release commit through a PR to `master`. Follow the existing
   `YYYY-MM-DD_short-title` branch convention. A title such as
   `chore: prepare v2.0.0 GitHub release --issue=#19` describes the preparation;
   commit and PR titles do not trigger publication.
5. Wait for CI to pass and merge the PR. CI checks PR conventions, TypeScript types,
   and the package build. A merge to `master` runs CI again but does not publish.

The commit you tag must include the release workflow itself. Do not tag an older
commit that still contains the previous publishing workflows.

## Tag the merged commit

Use the canonical repository, `infituit/opencode-acp`, not a fork. In the example
below its local remote is named `upstream`; substitute your actual canonical remote
name if different.

```bash
git fetch upstream master --tags
git switch master
git merge --ff-only upstream/master

git status --short
git log -1 --oneline
node -p "require('./package.json').version"
```

Confirm the worktree is clean, the merged release commit is correct, and its CI
run passed. Then create and push an annotated tag:

```bash
git tag -a v2.0.0 <merged-release-commit-sha> -m "ACP v2.0.0"
git push upstream refs/tags/v2.0.0
```

Replace the example version and commit SHA for each release. Push the tag using
your normal authenticated Git credentials. Tags pushed by another workflow using
`GITHUB_TOKEN` do not trigger a new workflow run; do not automate this step with
that token.

The Release workflow runs on `v*` tag pushes only. There is no manual dispatch or
merge-title-based release path. Restrict who can push release tags with repository
rulesets if publication requires a maintainer-only boundary.

## Automated build and publication

The tag workflow:

1. Checks out the tagged commit and checks that the tag equals
   `v${package.json.version}` and both lockfile versions match.
2. Requires the matching Chinese and English release notes.
3. Uses Node.js 22, installs dependencies with `npm ci --ignore-scripts`, and runs
   `npm run typecheck` and `npm run check:package`.
4. Runs `npm pack --ignore-scripts` after the build.
5. Creates `SHA256SUMS` for the tarball.
6. Creates a GitHub Release for the existing tag with the notes and both assets.
   Tags containing a hyphen, such as `v2.1.0-rc.1`, produce prereleases.

The resulting assets are:

- `opencode-acp-<version>.tgz`: the npm-format package with prebuilt `dist/` files;
  runtime dependencies are not bundled.
- `SHA256SUMS`: SHA-256 checksums for the tarball.

The workflow uses the repository's `GITHUB_TOKEN` with `contents: write` for
publication. It does not require an npm token or an additional release action.

## Confirm publication and install

Check the Release run in the canonical repository's **Actions** tab, then open the
corresponding GitHub Release. Verify the expected tag, notes, and both assets.
Downloaded assets can be checked with:

```bash
sha256sum -c SHA256SUMS
```

For normal installation, remove any previous ACP npm or local development plugin
entry to avoid loading multiple copies, then install the tag:

```bash
opencode plugin add github:infituit/opencode-acp#v2.0.0
```

This installs from Git, not from the Release tarball. Git and Node.js/npm are needed
for the package's `prepare` build. OpenCode's `plugin add` does not accept tarball
targets. Run `/reload`, start a new session, and use `/acp` to confirm the plugin is
available. Back up existing state before upgrading across incompatible versions;
copying V1 JSON state does not migrate it to V2 storage.

## Failures and retries

- If the workflow fails before creating a Release, inspect the failing step. For a
  transient failure with no Release or draft created, rerun the failed workflow.
- If the tagged source needs a fix, merge a new release commit with a new version,
  matching notes, and a new tag. Do not move or force-push a published version tag.
- Release creation and asset uploads are separate API requests. If publication
  fails midway, inspect GitHub Releases, including drafts, before retrying. The
  workflow does not overwrite an existing Release or its assets. A maintainer must
  resolve a partial draft explicitly; do not delete a published Release as a retry
  mechanism.
- A successful tag push makes the Git source installable before the Release build
  finishes. Wait for successful publication before announcing the release.

## References

- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Triggering a workflow from another workflow](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [GitHub CLI: `gh release create`](https://cli.github.com/manual/gh_release_create)
- [OpenCode plugin installation](https://opencode.ai/v2/docs/plugins)
