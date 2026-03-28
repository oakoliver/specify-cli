# Implementation Plan: CLI Commands Implementation

**Branch**: `009-cli-commands-implementation` | **Date**: 2026-03-28 | **Spec**: `specs/009-cli-commands-implementation/spec.md`
**Input**: Feature specification from `/specs/009-cli-commands-implementation/spec.md`

## Summary

Wire the existing `ExtensionManager` and `PresetManager` backend classes to CLI subcommands, and fix a critical ESM compatibility bug where `require()` calls in `extension.ts` crash at runtime in the ESM-bundled output. Changes are strictly additive and confined to two source files (`cli.ts` and `extension.ts`) plus test updates, ensuring upstream mergeability.

## Technical Context

**Language/Version**: TypeScript 5.0+ targeting ES2022  
**Primary Dependencies**: None (zero runtime dependencies per constitution). `@oakoliver/huh` and `@oakoliver/lipgloss` are the only permitted runtime dependencies.  
**Storage**: JSON registry files at `.specify/extensions/.registry` and `.specify/presets/.registry`  
**Testing**: `bun test` (Bun's built-in test runner)  
**Target Platform**: Node.js 18+, Bun 1.0+, Deno (multi-runtime ESM + CJS dual-publish)  
**Project Type**: CLI tool (`specify` binary via `dist/cli.js`)  
**Performance Goals**: N/A (CLI commands are interactive, single-invocation)  
**Constraints**: Zero third-party deps, minimal file changes for upstream mergeability, ESM-first with CJS fallback  
**Scale/Scope**: 14 new CLI subcommands (7 extension + 7 preset), 1 ESM bug fix, ~330 new lines in cli.ts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Zero Runtime Dependencies | **PASS** | No new dependencies. Only uses existing imports from `./extension.js`, `./preset.js`, `./config.js`, `./ui.js`, `node:fs`. |
| II. Multi-Runtime Compatibility | **PASS** | Uses only `process.cwd()`, `process.exit()`, `console.log()` and Node.js `fs` APIs already used elsewhere. No runtime-specific APIs introduced. |
| III. TypeScript-First | **PASS** | All new code is fully typed. No `any` types. Leverages existing `ExtensionManager`, `PresetManager`, `ExtensionInfo`, `PresetInfo` types. |
| IV. Oakoliver CLI Libraries | **PASS** | Uses existing `printSuccess`, `printError`, `printInfo` from `ui.ts` (which uses `@oakoliver/lipgloss`). No new UI patterns needed. |
| V. Idiomatic TypeScript API | **PASS** | camelCase methods, async/await for I/O, switch/case routing matches existing CLI patterns. |
| VI. 1:1 Migration Fidelity | **PASS** | Extension/preset CLI subcommands match Python spec-kit's command interface. Output format, exit codes, and error messages follow the same patterns. |

**Result**: All 6 principles PASS. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/009-cli-commands-implementation/
├── plan.md              # This file
├── research.md          # Phase 0: ESM fix strategy, CLI routing, output formatting
├── contracts/
│   └── cli-commands.md  # Phase 1: All 14 subcommand schemas
├── quickstart.md        # Phase 1: Usage examples
└── tasks.md             # Phase 2: 5-phase task breakdown (all complete)
```

### Source Code (repository root)

```text
src/
├── cli.ts          # MODIFIED: Replaced TODO stubs with extension/preset handlers (~330 new lines)
├── extension.ts    # MODIFIED: ESM fix (import change + 4 methods made async)
├── init.ts         # Previously fixed (readFileSync import)
├── check.ts        # Unchanged
├── config.ts       # Unchanged (provides findProjectRoot used by new CLI code)
├── types.ts        # Unchanged
├── registrar.ts    # Unchanged (provides registerCommands/unregisterCommands)
├── templates.ts    # Unchanged
├── preset.ts       # Unchanged (provides PresetManager)
├── ui.ts           # Unchanged (provides printSuccess/printError/printInfo)
└── index.ts        # Unchanged

tests/
├── extension.test.ts  # MODIFIED: 10 test functions made async, await added
├── preset.test.ts     # Unchanged
├── init.test.ts       # Unchanged
├── registrar.test.ts  # Unchanged
└── types.test.ts      # Unchanged
```

**Structure Decision**: Flat `src/*.ts` layout per constitution. No new files created. All changes are modifications to existing files at their TODO insertion points.

## Upstream Compatibility Strategy

Per spec requirement and constitution Principle VI:

1. **cli.ts**: TODO stubs at lines 117-127 replaced with handler functions. No existing code moved or deleted.
2. **extension.ts**: Line 13 import expanded. 4 method signatures gain `async` keyword. 2 `require()` calls replaced with direct function references. No logic restructuring.
3. **extension.test.ts**: `await` added to async method calls. No test logic changes.
4. **No new files**: All code lives in existing files where upstream expects it.

## Complexity Tracking

> No constitution violations. No complexity justifications needed.
