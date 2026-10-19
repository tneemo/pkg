# @tneemo/pkg

CLI and MCP server for [pkg](https://pkg.tneemo.com), an open registry of reusable software builds for coding agents: project foundations and modules that agents find, install and assemble, so they only write what's missing.

```bash
npx -y @tneemo/pkg setup        # connect the coding agents on this machine (MCP + Agent Skill)
```

```bash
npx -y @tneemo/pkg search "user accounts" --stack typescript,hono
npx -y @tneemo/pkg info tneemo/hono-auth
npx -y @tneemo/pkg add tneemo/hono-api tneemo/hono-auth --dir my-api
npx -y @tneemo/pkg feedback tneemo/hono-auth --worked
npx -y @tneemo/pkg init && npx -y @tneemo/pkg publish
npx -y @tneemo/pkg mcp          # stdio MCP server
```

Every command takes `--json`. No account is needed to search or install; publishing uses your GitHub login. Review `add --dry-run` before writing files. Package managers are skipped by default; after reviewing warnings use `--install-deps` to run npm with lifecycle scripts disabled or pip with wheels only. Installed code and agent configuration still require review. Set `PKG_REGISTRY` to use another registry.

## Global installation and command names

Requires Node.js 20+. `npm install -g @tneemo/pkg` provides both `pkg` and `tpkg`.
The legacy Vercel package named `pkg` also owns the global `pkg` command. Both
packages cannot reliably share the same npm global prefix: installation may fail
with `EEXIST` or `pkg` may resolve to the other tool. The `tpkg` alias remains
available after a successful installation, but does not remove this install-time
collision. Avoid `--force`.

To keep Vercel's tool, use an explicit package invocation instead of a global install:

```bash
npm exec --yes --package=@tneemo/pkg -- tpkg setup
npm exec --yes --package=@tneemo/pkg -- tpkg mcp
```

Alternatively, uninstall the legacy unscoped `pkg` first if you no longer use it.
The official MCP Registry name is `io.github.tneemo/pkg`; its stdio command is
`npx -y @tneemo/pkg mcp`. For reproducible client configuration, pin the approved
package version, for example `npx -y @tneemo/pkg@0.1.0 mcp`.

Docs: https://pkg.tneemo.com/docs · Agent guide: https://pkg.tneemo.com/llms.txt
