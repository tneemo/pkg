# Public distribution

The public npm package is `@tneemo/pkg`. Its `pkg` and `tpkg` commands are aliases
of `dist/pkg.js`. The official MCP Registry name is `io.github.tneemo/pkg`.
`server.json` describes stdio startup with the positional argument `mcp`.
The registry hosts metadata; npm hosts the executable package.

## Current publication

On 2026-10-19, the existing npm version `0.1.0` was registered using the official
`mcp-publisher` v1.8.1, after schema validation and GitHub namespace authentication.
No new npm version was published. The npm package already contained the matching
`mcpName`, both command aliases and the public repository URL.

Verify the live records from the repository root:

```bash
node scripts/check-distribution.mjs --published --registry
```

The existing npm `0.1.0` publication has no provenance attestation. The workflows
below generate provenance for the next approved npm publication; configuring a
workflow does not add an attestation to an already published package.

## npm trust configuration

`publish.yml` uses GitHub-hosted Ubuntu, Node.js 24, npm 11.19.0,
`id-token: write`, `npm publish --access public --provenance`, and no npm token or
`NODE_AUTH_TOKEN`. Actions are pinned to commit hashes, and the official
`mcp-publisher` binary is pinned to v1.8.1 with its SHA-256 checked before execution.

The remaining account-side setup requires npm account 2FA. Attempts to inspect
and create the trusted publisher on 2026-10-19 returned `EOTP`; account configuration
could not be verified or completed with the available CLI authentication.
The browser login also requires the owner's security key, which must be used by
the owner.
After signing in as a package maintainer, configure
[package Settings → Trusted publishing](https://www.npmjs.com/package/@tneemo/pkg/access):

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `tneemo` |
| Repository | `pkg` |
| Workflow filename | `publish.yml` (filename only) |
| Environment | Leave empty; the job does not declare an environment |
| Allowed operation | Direct `npm publish` |

An equivalent command, using an authenticated npm session and account 2FA, is:

```bash
npm trust github @tneemo/pkg --file publish.yml --repository tneemo/pkg --allow-publish
npm trust list @tneemo/pkg
```

Do this when the next release is approved: npm currently expires a new trust
configuration if it has not completed its first successful publish within two
days. If it expires, recreate the connection before the approved release.
Do not publish a version just to validate the connection. End-to-end OIDC and
provenance verification necessarily waits for that approved release.

Set package Publishing access to **Require two-factor authentication and disallow
tokens** to enforce token-free publishing at the npm account boundary. OIDC
continues to work with that restriction. No npm secret is needed in GitHub.

## Releasing an approved new version

No push, tag or GitHub Release triggers npm publication. The owner must approve a
specific version before invoking **Publish npm and MCP** from `main`.

1. After approval, update `cli/package.json`, `package-lock.json`'s CLI workspace
   version, and both version fields in `server.json` together. Keep `mcpName` and
   both `bin` aliases unchanged. Commit on `main`, and create `vVERSION` pointing
   exactly at that commit. Neither operation publishes anything.
2. Ensure the npm trusted publisher above is active and the public repository URL
   matches `cli/package.json`.
3. Run **Publish npm and MCP** (`publish.yml`) on `main`, entering the exact version
   and `publish @tneemo/pkg@VERSION` in the confirmation field.

The workflow rejects a mismatched confirmation, version, tag or existing npm
version. It validates metadata, typechecks, builds, runs the full test suite with
a local seeded registry, and inspects the package before publishing. It verifies
the npm ownership marker before using `mcp-publisher login github-oidc` and
`mcp-publisher publish server.json`. CI validates the same manifest on every PR.

After an approved release, inspect npm's provenance information and use:

```bash
npm view @tneemo/pkg@VERSION dist.attestations --json
node scripts/check-distribution.mjs --published --registry
```

## Recovering an MCP-only failure

If npm succeeds but the MCP publication fails, do not increment the version or
republish npm. Fix the registry issue and manually run **Publish existing npm
version to MCP** (`publish-mcp.yml`) from `main`, with `server.json` still pointing
to the already public npm version. This workflow has no `npm publish` step.
An already registered version can be verified with the script above instead.

For a local metadata publication, install the official publisher, then run:

```bash
mcp-publisher validate server.json
mcp-publisher login github
mcp-publisher publish server.json
mcp-publisher logout
```

GitHub authentication must control the `tneemo` namespace. CI obtains a short-lived
GitHub OIDC token and needs no personal access token. Never commit the local
`.mcpregistry_*` credentials. The official Registry remains in preview.

## External requirements verified

- npm package exists and is public; its published `mcpName` matches `server.json`.
- GitHub repository is public and its owner matches the Registry namespace.
- MCP Registry schema is `2025-12-11`; descriptions must be at most 100 characters.
- The package must exist on npm before MCP metadata publication.
- npm trusted publishing requires a matching workflow identity and a supported
  hosted runner; provenance requires a public package and public source repository.
- No custom domain verification, registry password, npm automation token or
  additional hosted MCP endpoint is required for this stdio server.

Sources: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[official MCP quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx),
[publisher commands](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md).
