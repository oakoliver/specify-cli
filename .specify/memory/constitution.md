<!--
## Sync Impact Report
- Version change: 1.1.0 → 1.2.0
- Modified principles: Principle I (clarified @oakoliver/* exception)
- Modified sections: Code Organization (aligned with actual flat src/ layout)
- Removed sections: None
- Templates requiring updates: ✅ None (changes are descriptive, not prescriptive)
- Follow-up TODOs: None
-->

# Spec-Kit TypeScript Port Constitution

## Mission

Enable Spec-Driven Development in corporate enterprise environments where Python installation is restricted or prohibited. By porting spec-kit to TypeScript/Bun with zero runtime dependencies, organizations can adopt SDD workflows using only Node.js/Bun - runtimes that are already approved and available in most enterprise development environments.

## Core Principles

### I. Zero Runtime Dependencies

The TypeScript port MUST have zero third-party runtime dependencies. The only permitted runtime dependencies are the `@oakoliver/*` CLI libraries (see Principle IV), which are maintained by the project author and provide essential terminal UI functionality. All other packages (esbuild, typescript, @types/node, etc.) MUST be devDependencies only. This ensures minimal bundle size, no external supply chain vulnerabilities, and maximum compatibility across Node.js, Bun, and Deno runtimes.

### II. Multi-Runtime Compatibility

All code MUST work on Node.js 18+, Bun 1.0+, and Deno without modification. Runtime-specific APIs require feature detection. Use standard ECMAScript APIs and Web APIs (fetch, crypto, etc.) when available.

### III. TypeScript-First

Full type safety is mandatory. No `any` types except where truly unavoidable (with explicit justification in comments). All public APIs MUST export their types. Use strict TypeScript configuration with `"strict": true`.

### IV. Oakoliver CLI Libraries

For all terminal UI and CLI functionality, MUST use the @oakoliver/* packages:
- `@oakoliver/bubbletea` for the Elm Architecture TUI framework
- `@oakoliver/bubbles` for pre-built TUI components (text input, list, spinner, etc.)
- `@oakoliver/lipgloss` for terminal styling
- `@oakoliver/glamour` for markdown rendering
- `@oakoliver/huh` for interactive forms and prompts

These replace Python's Typer/Rich and provide a consistent, battle-tested CLI experience.

### V. Idiomatic TypeScript API

Adapt the original Python API to TypeScript conventions:
- Use camelCase for functions/methods (not snake_case)
- Use classes where Python uses classes with methods
- Use `undefined` instead of Python's `None` sentinel
- Use async/await for I/O operations
- Use builder/fluent patterns where they improve ergonomics

### VI. 1:1 Migration Fidelity

This port MUST maintain exact behavioral parity with the original Python spec-kit repository (github/spec-kit). This principle ensures:

- **Output Format Compatibility**: JSON files (init-options.json, registries) MUST use identical keys and structure as the Python version. Use snake_case for JSON keys to match Python's output.
- **Directory Structure Parity**: The `.specify/` directory layout, file locations, and naming conventions MUST match the Python implementation exactly.
- **Command Behavior**: All CLI commands MUST produce equivalent results. When the Python version creates specific files in specific locations, the TypeScript port MUST do the same.
- **Agent Configuration**: The `AGENT_CONFIGS` dictionary MUST stay synchronized with the Python repository's agent definitions.
- **Template Content**: Bundled templates MUST be sourced from or validated against the Python repository to ensure consistency.

**Rationale**: By maintaining 1:1 parity, users can easily migrate between implementations, the TypeScript port can catch upstream improvements from the original repository, and testing can validate output equivalence. Any deviation from Python behavior MUST be explicitly documented and justified.

**Exception**: Internal implementation details (class names, module structure, async patterns) may differ to follow TypeScript idioms (Principle V), but external behavior and artifacts MUST match.

## Development Workflow

### Testing Requirements

- Tests written using Bun's built-in test runner (`bun test`)
- Test files named `*.test.ts` in `tests/` directory
- Coverage target: >90% for public API surface
- All user stories MUST have corresponding acceptance tests

### Code Organization

All source files reside in a flat `src/` directory:

- `src/index.ts` - Public API barrel export
- `src/cli.ts` - CLI entry point and command routing
- `src/init.ts` - `specify init` command logic
- `src/check.ts` - `specify check` command logic
- `src/types.ts` - All TypeScript types, agent configs, utility functions
- `src/config.ts` - Path constants, init-options persistence, project detection
- `src/registrar.ts` - Command registration/unregistration for all agents
- `src/templates.ts` - Template management and copying
- `src/extension.ts` - Extension manifest, registry, and manager
- `src/preset.ts` - Preset manifest, registry, manager, and resolver
- `src/ui.ts` - Terminal styling and output helpers

## Quality Gates

### Pre-Commit

- TypeScript compilation MUST pass (`bun run typecheck`)
- All tests MUST pass (`bun test`)
- No ESLint errors (when configured)

### Pre-Publish

- Build MUST succeed for all formats (ESM, CJS, types)
- Package size MUST be reasonable (< 1MB unpacked)
- README MUST include: description, installation, usage examples, API reference

## Governance

This constitution supersedes all other practices. Amendments require:
1. Documentation of the proposed change
2. Justification for the amendment
3. Migration plan if breaking existing features

All PRs must verify compliance with these principles.

**Version**: 1.2.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-03-28
