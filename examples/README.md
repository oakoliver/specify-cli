# Examples

Two short sessions: check which upstream release the CLI matches, then set up one project for several coding agents. Run them in any empty directory.

With the published package, use `npx @oakoliver/specify-cli` (or `bunx`) in place of `specify`. From a checkout, run `bun run build` once, then use `node dist/cli.js`.

## Check upstream parity

```sh
specify version
```

This prints the banner and an information panel. The `Upstream Parity` row names the spec-kit release this port matches, for example `spec-kit 1.0.12`. The panel also shows the Node, platform and OpenSSL versions.

## One project, several agents

```sh
specify init lantern-notes --integration claude --script sh --ignore-agent-tools
cd lantern-notes
specify integration install codex
specify integration install gemini
specify integration list
specify integration status
```

- **`init`** scaffolds `lantern-notes/` with Claude Code as the default integration and POSIX shell scripts. `--ignore-agent-tools` skips the check that the agent's own CLI is installed.
- **`integration install`** adds more agents alongside the default. It works for integrations marked "Multi-install Safe" in the list.
- **`integration list`** shows every available integration. Its columns show which are installed and which is the default, whether each needs its own CLI, and whether it can share a project with others.
- **`integration status`** checks the installed integrations' managed files without changing anything.

To make another installed integration the default, run `specify integration use <key>`. To remove one, run `specify integration uninstall <key>`; files you have edited are kept.
