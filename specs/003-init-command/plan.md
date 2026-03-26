# Implementation Plan: Init Command

**Branch**: `003-init-command` | **Date**: 2026-03-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-init-command/spec.md`

## Summary

Implement the `specify init` command — the primary entry point for spec-kit. Creates project directory structure, copies templates, registers AI agent commands, and optionally initializes git. Uses @oakoliver/huh for interactive prompts and @oakoliver/lipgloss for styled output.

## Technical Context

**Language/Version**: TypeScript 5.0+ / Bun 1.0+
**Primary Dependencies**: @oakoliver/huh (interactive forms), @oakoliver/lipgloss (styling), node:fs, node:path
**Storage**: File system (project directory)
**Testing**: Bun test runner (`bun test`)
**Target Platform**: Node.js 18+, Bun 1.0+, Deno
**Project Type**: CLI command
**Performance Goals**: Init completes in <5 seconds (offline mode)
**Constraints**: Zero runtime dependencies beyond @oakoliver/* packages

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Zero Runtime Dependencies | ✅ PASS | Only @oakoliver/* packages (allowed by constitution) |
| II. Multi-Runtime Compatibility | ✅ PASS | Uses node:fs, node:path, node:child_process |
| III. TypeScript-First | ✅ PASS | All CLI args and options fully typed |
| IV. Oakoliver CLI Libraries | ✅ PASS | Uses @oakoliver/huh for prompts, lipgloss for styling |
| V. Idiomatic TypeScript API | ✅ PASS | camelCase, async/await |

## Project Structure

### Documentation (this feature)

```text
specs/003-init-command/
├── plan.md              # This file
├── research.md          # Template bundling research
├── tasks.md             # Implementation tasks
└── checklists/          # Quality checklists
```

### Source Code (repository root)

```text
src/
├── index.ts             # Re-export init
├── cli.ts               # CLI entry point with arg parsing
├── init.ts              # NEW: Init command implementation
├── templates.ts         # NEW: Template bundling/extraction
└── ui.ts                # NEW: TUI components (banner, progress)

templates/               # NEW: Bundled templates
├── scripts/
│   ├── bash/
│   └── powershell/
├── commands/            # Command templates (specify, plan, tasks, etc.)
└── files/               # Other template files

tests/
├── init.test.ts         # NEW: Init command tests
└── templates.test.ts    # NEW: Template tests
```

**Structure Decision**: Separate modules for clarity. `init.ts` handles command logic, `templates.ts` handles file operations, `ui.ts` handles display.

## Key Design Decisions

### 1. CLI Argument Parsing (Zero Dependencies)

We need to parse CLI args without Commander.js or Yargs. Simple approach:

```typescript
interface InitOptions {
  projectName?: string;
  ai?: string;
  here?: boolean;
  force?: boolean;
  script?: 'sh' | 'ps';
  branchNumbering?: 'sequential' | 'timestamp';
  noGit?: boolean;
  offline?: boolean;
  aiSkills?: boolean;
}

function parseArgs(args: string[]): InitOptions {
  const opts: InitOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--ai' && args[i + 1]) {
      opts.ai = args[++i];
    } else if (arg === '--here') {
      opts.here = true;
    } else if (arg === '--force' || arg === '-f') {
      opts.force = true;
    } else if (arg === '--script' && args[i + 1]) {
      opts.script = args[++i] as 'sh' | 'ps';
    } else if (arg === '--branch-numbering' && args[i + 1]) {
      opts.branchNumbering = args[++i] as 'sequential' | 'timestamp';
    } else if (arg === '--no-git') {
      opts.noGit = true;
    } else if (arg === '--offline') {
      opts.offline = true;
    } else if (arg === '--ai-skills') {
      opts.aiSkills = true;
    } else if (!arg.startsWith('-') && !opts.projectName) {
      opts.projectName = arg;
    }
  }
  
  return opts;
}
```

### 2. Template Bundling Strategy

Templates are bundled in the npm package under `templates/`. At runtime:

```typescript
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function getTemplatesDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, '..', 'templates');
}
```

### 3. Interactive Agent Selection with @oakoliver/huh

When `--ai` is not provided:

```typescript
import { Form, Select } from '@oakoliver/huh';
import { SUPPORTED_AGENTS } from './types.js';

async function selectAgent(): Promise<string> {
  const field = new Select<string>()
    .title('AI Assistant')
    .description('Select your AI coding agent')
    .options(SUPPORTED_AGENTS.map(a => ({ label: a, value: a })))
    .filtering(true);
    
  const form = new Form(field);
  await form.run();
  
  return field.value();
}
```

### 4. Styled Output with @oakoliver/lipgloss

```typescript
import { Style } from '@oakoliver/lipgloss';

const styles = {
  title: new Style().bold(true).foreground('12'),
  success: new Style().foreground('10'),
  error: new Style().foreground('9'),
  dim: new Style().foreground('8'),
};

function printStep(name: string, done: boolean): void {
  const icon = done ? styles.success.render('✓') : styles.dim.render('○');
  console.log(`${icon} ${name}`);
}
```

### 5. Directory Structure Creation

Match Python's output exactly:

```text
<project>/
├── .specify/
│   ├── templates/
│   │   ├── spec-template.md
│   │   ├── plan-template.md
│   │   ├── tasks-template.md
│   │   └── commands/
│   ├── scripts/
│   │   └── bash/ (or powershell/)
│   ├── memory/
│   │   └── constitution.md
│   ├── extensions/
│   ├── presets/
│   └── init-options.json
├── specs/
└── <agent-folder>/
    └── <commands>/
```

### 6. Git Initialization (Optional)

```typescript
import { execSync } from 'node:child_process';

function initGit(projectRoot: string): boolean {
  try {
    execSync('git init', { cwd: projectRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

## Complexity Tracking

No constitution violations. Uses approved @oakoliver/* packages.

## Dependencies

- **Depends on**: 
  - Spec 002 (Core Types) - `AGENT_CONFIGS`, `SUPPORTED_AGENTS`, `InitOptions`
  - Spec 005 (Agent System) - `registerCommands()`
- **Depended on by**: Spec 006 (Extensions), Spec 007 (Presets)
