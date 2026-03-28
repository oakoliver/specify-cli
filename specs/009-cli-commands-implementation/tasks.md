# Tasks: CLI Commands Implementation (009)

## Phase 1: Setup & Verification [US1]

### Task 1.1: Verify project builds and tests pass
- [X] Run `bun test` and confirm all existing tests pass
- [X] Run `bun run build` and confirm the build succeeds
- [X] **Checkpoint**: Green baseline before any changes

## Phase 2: ESM Fix in extension.ts [US1]

### Task 2.1: Replace require() with static ESM imports
- [X] In `src/extension.ts` line 13, add `registerCommands` and `unregisterCommands` to the existing import from `'./registrar.js'`
- [X] Remove `require('./registrar.js')` at line 793 (in `registerExtensionCommands` method) and use the static import
- [X] Remove `require('./registrar.js')` at line 859 (in `unregisterCommands` method) and use the static import

### Task 2.2: Make affected methods async
- [X] Make `registerExtensionCommands` method async (private method, ~line 783)
- [X] Make `unregisterCommands` method async (private method, ~line 853)
- [X] Make `installFromDirectory` method async (calls `registerExtensionCommands`)
- [X] Make `remove` method async (calls `unregisterCommands`)
- [X] Make `enable` method async (calls `registerExtensionCommands`) — NOT NEEDED: enable only calls registry.update
- [X] Make `disable` method async (calls `unregisterCommands`) — NOT NEEDED: disable only calls registry.update

### Task 2.3: Update extension tests
- [X] In `tests/extension.test.ts`, add `await` to all calls of `installFromDirectory`, `remove`, `enable`, `disable`
- [X] Run `bun test` to verify all extension tests still pass
- [X] **Checkpoint**: ESM fix complete, all tests green

## Phase 3: Extension CLI Commands [US2, US3, US6, US7]

### Task 3.1: Add imports to cli.ts
- [X] Import `ExtensionManager` from `'./extension.js'`
- [X] Import `PresetManager` from `'./preset.js'`
- [X] Import `findProjectRoot` from `'./config.js'`
- [X] Import `existsSync` from `'node:fs'`

### Task 3.2: Implement extension subcommand routing [US2]
- [X] Replace the TODO stub at lines 117-121 with a switch on `args[1]` (the subcommand)
- [X] Add project root validation using `findProjectRoot(process.cwd())` with error message and exit 1
- [X] Implement `specify extension list` subcommand [FR-001]
- [X] Implement `specify extension info <id>` subcommand [FR-002]

### Task 3.3: Implement extension add/remove [US3]
- [X] Implement `specify extension add <path> [--priority <n>]` subcommand [FR-003]
- [X] Implement `specify extension remove <id>` subcommand [FR-004]

### Task 3.4: Implement extension enable/disable/priority [US6, US7]
- [X] Implement `specify extension enable <id>` subcommand [FR-005]
- [X] Implement `specify extension disable <id>` subcommand [FR-006]
- [X] Implement `specify extension priority <id> <n>` subcommand [FR-014]
- [X] Add unknown subcommand handling with error message
- [X] **Checkpoint**: All 7 extension subcommands wired

## Phase 4: Preset CLI Commands [US4, US5, US6, US7]

### Task 4.1: Implement preset subcommand routing [US4] [P]
- [X] Replace the TODO stub at lines 123-127 with a switch on `args[1]`
- [X] Add project root validation (same pattern as extension)
- [X] Implement `specify preset list` subcommand [FR-007]
- [X] Implement `specify preset info <id>` subcommand [FR-008]

### Task 4.2: Implement preset add/remove [US5] [P]
- [X] Implement `specify preset add <path> [--priority <n>]` subcommand [FR-009]
- [X] Implement `specify preset remove <id>` subcommand [FR-010]

### Task 4.3: Implement preset enable/disable/priority [US6, US7] [P]
- [X] Implement `specify preset enable <id>` subcommand [FR-011]
- [X] Implement `specify preset disable <id>` subcommand [FR-012]
- [X] Implement `specify preset priority <id> <n>` subcommand [FR-013]
- [X] Add unknown subcommand handling with error message
- [X] **Checkpoint**: All 7 preset subcommands wired

## Phase 5: Build & Validation [All US]

### Task 5.1: Run full test suite
- [X] Run `bun test` and verify all tests pass
- [X] Run `bun run build` and verify ESM + CJS bundles build successfully

### Task 5.2: Manual smoke tests
- [X] Test `specify extension list` in an initialized project
- [X] Test `specify preset list` in an initialized project
- [X] Test error case: run commands outside a spec-kit project
- [X] Test error case: unknown subcommand
- [X] **Checkpoint**: All acceptance criteria met, implementation complete
