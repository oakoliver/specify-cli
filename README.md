# @oakoliver/specify-cli

Spec-Driven Development CLI for AI coding agents. Zero runtime dependencies, multi-runtime (Node.js 18+, Bun, Deno).

Ported from [github/spec-kit](https://github.com/github/spec-kit) (Python) to TypeScript.

## Install

```bash
npm install -g @oakoliver/specify-cli
# or
bun install -g @oakoliver/specify-cli
```

## Quick Start

```bash
# Initialize a new project with interactive agent selection
specify init my-project

# Or specify the agent directly
specify init my-project --ai opencode

# Initialize in current directory
specify init . --ai claude --here

# Check project structure
specify check
```

## Supported AI Agents

23 AI coding agents supported:

| Agent | Command Directory | Format |
|-------|------------------|--------|
| claude | `.claude/commands/` | Markdown |
| copilot | `.github/agents/` | Markdown + `.prompt.md` |
| gemini | `.gemini/commands/` | TOML |
| opencode | `.opencode/command/` | Markdown |
| cursor | `.cursor/commands/` | Markdown |
| codex | `.agents/skills/` | SKILL.md |
| windsurf | `.windsurf/workflows/` | Markdown |
| tabnine | `.tabnine/agent/commands/` | TOML |
| kimi | `.kimi/skills/` | SKILL.md |
| *and 14 more...* | | |

## Commands Installed

When you run `specify init`, these slash commands are installed for your agent:

| Command | Description |
|---------|-------------|
| `/speckit.specify` | Create feature specification from natural language |
| `/speckit.plan` | Create implementation plan from spec |
| `/speckit.tasks` | Generate task breakdown from plan |
| `/speckit.implement` | Execute implementation tasks |
| `/speckit.clarify` | Clarify spec requirements |
| `/speckit.analyze` | Analyze codebase |
| `/speckit.checklist` | Create/manage checklists |
| `/speckit.constitution` | Create/edit project constitution |
| `/speckit.taskstoissues` | Convert tasks to GitHub issues |

## CLI Options

```bash
specify init <project-name> [options]

Options:
  --ai <agent>              AI agent to configure (default: interactive)
  --here                    Initialize in current directory
  --force                   Overwrite existing files
  --no-git                  Skip git initialization
  --script <sh|ps>          Shell script type (default: sh)
  --branch-numbering <mode> sequential or timestamp (default: sequential)
  --ai-skills               Generate SKILL.md files
  --ai-commands-dir <dir>   Custom commands directory (for generic agent)
  --offline                 Use bundled assets only
  --help                    Show help
  --version                 Show version
```

## Project Structure

After `specify init`, your project will have:

```
my-project/
├── .specify/
│   ├── init-options.json      # Saved configuration
│   ├── memory/
│   │   └── constitution.md    # Project constitution
│   ├── templates/             # Spec/plan/tasks templates
│   ├── scripts/
│   │   └── bash/              # Helper scripts
│   ├── extensions/            # Installed extensions
│   └── presets/               # Installed presets
├── .<agent>/                  # Agent-specific config
│   └── commands/              # Installed slash commands
└── specs/                     # Feature specifications
```

## Workflow

1. **Create a feature branch**: `.specify/scripts/bash/create-new-feature.sh "my-feature"`
2. **Write the spec**: Run `/speckit.specify` in your AI agent
3. **Create the plan**: Run `/speckit.plan`
4. **Break down tasks**: Run `/speckit.tasks`
5. **Implement**: Run `/speckit.implement`

## Extensions & Presets

```bash
# Install an extension
specify extension add <extension-name>

# List installed extensions
specify extension list

# Install a preset
specify preset add <preset-name>

# List installed presets
specify preset list
```

## Programmatic API

```typescript
import { init, check, AGENT_CONFIGS, SUPPORTED_AGENTS } from '@oakoliver/specify-cli';

// Initialize a project programmatically
await init({
  projectName: 'my-project',
  ai: 'opencode',
  script: 'sh',
  branchNumbering: 'sequential',
  noGit: false,
});

// Check project structure
const result = await check({ fix: false });
console.log(result.overall); // 'valid' | 'fixable' | 'invalid'
```

## Attribution

This is a TypeScript port of [github/spec-kit](https://github.com/github/spec-kit), originally written in Python. Licensed under MIT.

## License

MIT
