# Security and quality audit remediation

Changes responding to `tpkg-security-quality-audit.md` (19 October 2026).
These are source changes; production rollout remains a separate maintainer action.

| Finding | Change | Verification |
|---|---|---|
| F01 | Package managers require explicit opt-in after review. npm uses `--ignore-scripts`; pip accepts wheels only. Decode base64 text before inspection, apply filename checks regardless of encoding, and correct MCP destructive hints and execution claims. | Encoded lifecycle/config fixtures; harmless lifecycle marker remains absent both by default and with dependency opt-in. |
| F02 | Reject protected segments regardless of case, control characters, ADS, trailing dots/spaces, device names and short-name aliases. Validate lockfile paths too. | Windows alias regressions. |
| F03 | Check root/ancestors/targets with lstat and canonical paths for planning, writes, hashes and deletions, including merge targets. | Real Windows junction and dangling-link regressions; MCP update/remove tests. |
| F04 | Restrict dependencies to validated registry package names/ranges and single-line PEP 440 specifiers. Parse and serialize TOML structurally. Reject installer options, direct URLs, VCS/local references and unsupported dynamic dependency sources. | Directive/multiline/source-policy fixtures. |
| F05 | Public npm metadata now returns `0.1.0`; the earlier 404 no longer reproduces. Add packed/public artifact smoke checks for both executables, isolated setup and MCP. Keep upstream explicit publication guards. Prepare synchronized `0.2.0` metadata. | Fresh tarball installation, both aliases, isolated Cursor/Codex setup, MCP handshake/tool listing, distribution tests. New public release still required. |
| F06 | Extract effective dependencies from manifest maps, decoded package.json (including optional/peer dependencies), requirements files and static TOML. Reject over 80 package names; verify matching releases and fail closed on network/HTTP errors. | File-only missing package, nonexistent version and offline-upstream regressions; all six examples published locally. |
| F07 | Include installed consumers in resolution and pin builds staying unchanged, for both add and partial update. | Incompatible shared-transitive update rejected before writes. |
| F08 | Backtrack candidate versions with their dependency edges, so discarded versions leave no stale requirements. | Discarded-version dependency fixture. |
| F09 | Surface dependency failures as exceptions, nonzero CLI status and MCP errors with command output. Explicit retries run even when build versions are unchanged. | Missing-package-manager failure and successful unchanged-build retry. |
| F10 | Share structural schema between editor/server/client plus semantic validation. Validate resolved metadata and decoded bundles before planning. Stage merges and include project files and lockfile in rollback on write failure. | Nested null/array/type regressions; full MCP tests. |
| F11 | Node socket peer is the default identity; forwarded headers require a caller-provided trusted policy. Bound key cardinality and fail closed at capacity. | Assembled middleware spoofing and capacity regressions. |
| F12 | Upload under content-addressed keys and commit the authoritative pointer/hash in a D1 batch. Duplicate publication cannot overwrite committed bytes. Alternate readers verify integrity and reject yanked releases. | Controlled concurrent publish race, hash verification and yanked-reader regression. |
| F13 | Retire replayable download increments and remove historical download counts from reputation and provider ordering. Label retained counts as historical raw downloads. | Repeated reads leave counts unchanged and inflated historical totals cannot change reputation. |
| F14 | Constrain grid tracks/children and command scrolling; wrap segmented controls and implement keyboard tab navigation. | Chromium at 320/390/430px, home and build pages, normal and 200% text, plus arrow-key selection. |

## Validation

- Repository typecheck and CLI build pass.
- 22 repository tests pass against a seeded disposable Worker; no skips.
- Assembled Node examples: 11 tests and typecheck pass.
- Assembled Python examples: 5 tests pass (one upstream Starlette/httpx deprecation warning).
- Root dependency audit reports zero advisories.
- CLI tarball smoke passes; bundled dependency license notices are included.
- CI runs the assembled examples and packed artifact smoke; the explicitly approved release workflow also checks the public npm artifact after publication.

## Rollout and compatibility

1. Review and merge the changes. Apply D1 migration `0002_content_addressed_bundles.sql` before deploying the Worker. Existing releases retain their legacy R2 keys; new releases use the stored content-addressed pointer.
2. Deploy the Worker and verify preview/production behavior. Losing/failed publications may leave unreferenced content-addressed objects; garbage collection must check authoritative references before deleting anything.
3. Publish CLI `0.2.0` through the existing approved npm/MCP release workflow, then publish the updated `hono-rate-limit` build as `1.0.1`. The new source and local fixtures do not alter already-published artifacts.
4. Run exact public setup/MCP/install commands from a fresh workspace after publication. Until release, use the reviewed local tarball to evaluate the changes.

The CLI now requires Node >=24.10.0, following its bundled dependency requirement. Dependency installation is disabled unless `--install-deps` (CLI) or `install_dependencies: true` (MCP) is supplied; use a dry run first. Automatic Node dependency installation supports npm only. Other package managers, source distributions, direct references, workspaces/overrides and dynamic Python dependency sources require manual review and installation. Updating TOML dependencies preserves parsed values but may reformat the file and drop comments.

The filesystem checks assume an adversary is not concurrently replacing project paths between checks and operations; they narrow races but are not an OS sandbox. Rollback handles ordinary operation errors, not power loss or process termination. Raw downloads are no longer counted as installs; no replacement unique-install claim is made. Organization publishing authority, production quotas/moderation, edge configuration and other unverified design risks in the audit still require separate operational review.
