# Research: CLI Commands Implementation

**Date**: 2026-03-28  
**Feature**: 009-cli-commands-implementation

## Upstream Compatibility Analysis

### Question: How do we keep changes mergeable with github/spec-kit?

**Finding**: The codebase structure is flat `src/*.ts` (not the nested `src/cli/`, `src/core/` that the constitution prescribes). This means:

- `src/cli.ts` is the single CLI entry point (141 lines, switch-based routing)
- `src/extension.ts` is a 962-line file with all extension types + logic
- `src/preset.ts` is a 720-line file with all preset types + logic
- No `src/cli/` subdirectory exists

The upstream Python spec-kit likely has a similar flat structure. Any structural reorganization would make future merges painful.

**Decision**: Make targeted, minimal edits to existing files only. No new files, no file moves, no reorganization.

**Rationale**: Upstream improvements to extension.ts or cli.ts will merge cleanly when our changes are small, localized additions rather than rewrites.

**Rules for upstream-safe changes**:
1. Edit existing TODO stubs in cli.ts (lines 117-127) - these are already marked for replacement
2. Fix require() in extension.ts with minimal line changes (import statement + method signatures)
3. Keep all logic in the same files where the upstream has it
4. Match the coding patterns already established (switch/case, manual arg parsing, printError for errors)

---

## Research Task 1: ESM `require()` Fix Strategy

### Question: How to replace `require('./registrar.js')` in extension.ts (lines 793, 859)?

**Finding**: 

1. `registrar.ts` does NOT import from `extension.ts` - there is **no circular dependency**. The `require()` was a misguided porting artifact from Python's lazy import pattern.
2. Line 13 of extension.ts already has `import { parseFrontmatter } from './registrar.js'` - proving ESM imports work fine.
3. However, `registerCommands` and `unregisterCommands` in registrar.ts are **async** functions.
4. The current code at line 805 calls `registerCommands(agent, commands, ...)` synchronously via `require()`. With ESM bundling, the Promise return value would be silently ignored, causing commands to never actually register.

**Decision**: Add `registerCommands` and `unregisterCommands` to the existing top-level import at line 13. Make the calling private methods `async`, and propagate `async` up through `installFromDirectory`, `remove`, `enable`, and `disable`.

**Rationale**: 
- Fixes the ESM runtime error
- Fixes the silent Promise-ignoring bug
- Minimal diff: one import line change + `async`/`await` keywords added to ~6 methods
- No structural changes to extension.ts

**Alternatives Rejected**:
- Keep synchronous + use `import()`: Creates ugly `.then()` chains or breaks the return type
- Restructure to avoid async: Not possible since registrar functions are fundamentally async (they write files)
- Dynamic `import()` in method body: Creates the same async propagation requirement with more code

**Impact**: Methods that become async:
- `private registerExtensionCommands()` -> `private async registerExtensionCommands()`
- `private unregisterCommands()` -> `private async unregisterCommands()`
- `installFromDirectory()` -> `async installFromDirectory()` (calls registerExtensionCommands)
- `remove()` -> `async remove()` (calls unregisterCommands)
- `enable()` -> `async enable()` (calls registerExtensionCommands internally if enabling)
- `disable()` -> `async disable()` (calls unregisterCommands internally if disabling)

**Test impact**: Tests calling these methods need `await`. Minimal change.

---

## Research Task 2: CLI Routing Pattern

### Question: How should extension/preset subcommands be routed?

**Finding**: Existing commands use this pattern in cli.ts:
```typescript
case 'init': {
  const options = parseInitArgs(args);
  await init(options);
  break;
}
```

For subcommands (`specify extension list`, `specify extension add <path>`), the subcommand is `args[0]` after the main command is matched.

**Decision**: Follow the same switch/case pattern. Extract `args` after matching `extension`/`preset`, then switch on `args[0]`:
```
specify extension list              -> ExtensionManager.listInstalled()
specify extension add <path>        -> ExtensionManager.installFromDirectory()
specify extension remove <id>       -> ExtensionManager.remove()
specify extension info <id>         -> ExtensionManager.getExtension()
specify extension enable <id>       -> ExtensionManager.enable()
specify extension disable <id>      -> ExtensionManager.disable()
specify extension priority <id> <n> -> ExtensionManager.setPriority()
```

Same pattern for preset subcommands.

**Rationale**: Consistent with existing code. The TODO stubs at lines 117-127 are the exact insertion points.

---

## Research Task 3: Output Formatting

### Question: How should command output be formatted?

**Finding**: `src/ui.ts` provides:
- `printSuccess(msg)` - green checkmark prefix
- `printError(msg)` - red X prefix  
- `printInfo(msg)` - blue info prefix
- `printWarning(msg)` - yellow warning prefix

These are already used by init/check commands.

**Decision**: Use existing UI helpers for all output. For list commands, format as a simple table using console.log with alignment.

**Rationale**: Consistent with existing output style. No new UI dependencies needed.

---

## Research Task 4: Project Validation

### Question: How to validate we're in a spec-kit project before running commands?

**Finding**: `src/config.ts` exports `isSpeckitProject(dir)` which checks for `.specify` directory existence.

**Decision**: Call `isSpeckitProject(process.cwd())` at the start of extension/preset command handlers. Print error and exit if false.

---

## Research Task 5: Version String for Install

### Question: `installFromDirectory` requires a `speckitVersion` parameter. Where does this come from?

**Finding**: `package.json` has `"version": "0.1.0"`. The init command reads this. Need to import or define version constant.

**Decision**: Import version from a constant or read from package.json. Follow existing pattern from init.ts.

---

## Summary of Decisions

| Decision | Rationale | Upstream Impact |
|----------|-----------|-----------------|
| Top-level import for registrar functions | No circular dep exists, fixes ESM | 1 line change in imports |
| Async propagation for 6 methods | registerCommands/unregisterCommands are async | Add `async`/`await` keywords |
| Switch/case in existing TODO stubs | Matches init/check pattern | Replaces TODO placeholders |
| Use existing ui.ts helpers | Consistent output formatting | No new code |
| No new files or restructuring | Upstream mergeability | Zero structural changes |
