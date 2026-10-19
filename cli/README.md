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

Every command takes `--json`. No account is needed to search or install; publishing uses your GitHub login. Installing never runs code from a build. Set `PKG_REGISTRY` to use another registry.

Docs: https://pkg.tneemo.com/docs · Agent guide: https://pkg.tneemo.com/llms.txt
