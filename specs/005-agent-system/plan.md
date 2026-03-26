# Implementation Plan: Agent Registration System

**Branch**: `005-agent-system` | **Date**: 2026-03-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-agent-system/spec.md`

## Summary

Implement the CommandRegistrar system that registers slash commands to different AI coding agents. Each of 23 supported agents has unique folder structures, file formats (Markdown/TOML/SKILL.md), and naming conventions. This module handles format conversion, frontmatter parsing, and file management for all agents.

## Technical Context

**Language/Version**: TypeScript 5.0+ / Bun 1.0+
**Primary Dependencies**: @oakoliver/lipgloss (styling only), node:fs, node:path
**Storage**: File system (agent command directories)
**Testing**: Bun test runner (`bun test`)
**Target Platform**: Node.js 18+, Bun 1.0+, Deno
**Project Type**: CLI library module
**Performance Goals**: Register all 9 commands for an agent in <100ms
**Constraints**: Zero runtime dependencies (per constitution)
**Scale/Scope**: 23 agents × 9 core commands = 207 potential command files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Zero Runtime Dependencies | ✅ PASS | Uses only node:fs, node:path built-ins |
| II. Multi-Runtime Compatibility | ✅ PASS | Standard fs APIs work across Node/Bun/Deno |
| III. TypeScript-First | ✅ PASS | All functions fully typed, no `any` |
| IV. Oakoliver CLI Libraries | ⚠️ N/A | This module has no TUI components |
| V. Idiomatic TypeScript API | ✅ PASS | camelCase, async/await, classes |

## Project Structure

### Documentation (this feature)

```text
specs/005-agent-system/
├── plan.md              # This file
├── research.md          # YAML/TOML parsing research
├── data-model.md        # CommandDefinition, RegisteredCommands types
├── quickstart.md        # Usage examples
├── contracts/           # Public API contracts
│   └── registrar.ts     # CommandRegistrar interface
└── tasks.md             # Implementation tasks
```

### Source Code (repository root)

```text
src/
├── index.ts             # Re-export registrar
├── types.ts             # Already exists (from spec 002)
├── config.ts            # Already exists (from spec 002)
└── registrar.ts         # NEW: CommandRegistrar implementation

tests/
└── registrar.test.ts    # NEW: Registrar tests
```

**Structure Decision**: Single module in `src/registrar.ts` since this is a focused utility. No subdirectories needed.

## Key Design Decisions

### 1. YAML Frontmatter Parsing (Zero Dependencies)

YAML parsing without a library. We only need to parse simple key-value frontmatter, not full YAML.

```typescript
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }
  
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }
  
  const yamlBlock = content.slice(4, endIndex);
  const frontmatter = parseSimpleYaml(yamlBlock);
  const body = content.slice(endIndex + 4).trim();
  
  return { frontmatter, body };
}
```

### 2. TOML Generation (Zero Dependencies)

Generate TOML for Gemini/Tabnine without a TOML library:

```typescript
function toToml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Use triple quotes for multiline strings
      if (value.includes('\n')) {
        lines.push(`${key} = """\n${value}\n"""`);
      } else {
        lines.push(`${key} = "${escapeTomlString(value)}"`);
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${key} = ${value}`);
    }
  }
  return lines.join('\n');
}
```

### 3. SKILL.md Format for Codex/Kimi

Skill-based agents use directory-per-command structure:

```text
.agents/skills/
└── speckit.specify/
    └── SKILL.md
```

The SKILL.md format uses agentskills.io frontmatter:

```markdown
---
name: speckit.specify
description: Create a feature specification
---

[command body]
```

### 4. Copilot Companion Files

Copilot requires both `.agent.md` and `.prompt.md` files:

```text
.github/agents/speckit.specify.agent.md
.github/prompts/speckit.specify.prompt.md
```

## Complexity Tracking

No constitution violations. Simple module with clear boundaries.

## Dependencies

- **Depends on**: Spec 002 (Core Types) - `AGENT_CONFIGS`, utility functions
- **Depended on by**: Spec 003 (Init Command), Spec 006 (Extensions), Spec 007 (Presets)
