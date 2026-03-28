# Feature Specification: CLI Commands Implementation

**Feature Branch**: `009-cli-commands-implementation`  
**Created**: 2026-03-28  
**Status**: Draft  
**Depends On**: 006-extensions, 007-presets
**Input**: Complete missing CLI commands for extension and preset management

## Overview

The TypeScript port has backend implementations for extensions (`ExtensionManager`, `ExtensionRegistry`) and presets (`PresetManager`, `PresetRegistry`, `PresetResolver`), but the CLI subcommands were left as TODOs. This feature wires up the existing backend to CLI commands and fixes a critical ESM compatibility bug.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix ESM Runtime Error (Priority: P0)

As a developer, I want `specify init` to complete without crashing during git initialization, so that I can use the CLI reliably.

**Why this priority**: Critical bug - the CLI crashes with "Dynamic require of 'fs' is not supported" during the "Initializing git" step due to `require()` calls in ESM context.

**Independent Test**: Run `specify init . --ai opencode --force` and verify it completes all steps including git initialization.

**Acceptance Scenarios**:

1. **Given** an ESM bundle, **When** I run `init`, **Then** no dynamic `require()` errors occur
2. **Given** extension.ts with dynamic imports, **When** built with esbuild, **Then** the bundle works in Node.js ESM mode

---

### User Story 2 - Extension List/Info (Priority: P1)

As a developer, I want to run `specify extension list` to see installed extensions, so that I can audit what's in my project.

**Why this priority**: Most common extension operation - visibility into what's installed.

**Independent Test**: Install an extension manually, run `specify extension list`, verify it appears.

**Acceptance Scenarios**:

1. **Given** installed extensions, **When** I run `extension list`, **Then** each shows ID, version, and enabled status
2. **Given** no extensions, **When** I run `extension list`, **Then** it shows "No extensions installed"
3. **Given** an extension ID, **When** I run `extension info <id>`, **Then** it shows full metadata

---

### User Story 3 - Extension Add/Remove (Priority: P1)

As a developer, I want to install and remove extensions via CLI, so that I can manage project capabilities.

**Why this priority**: Core extension lifecycle management.

**Independent Test**: Run `extension add <path>`, verify files copied and commands registered. Run `extension remove <id>`, verify cleanup.

**Acceptance Scenarios**:

1. **Given** a local extension directory, **When** I run `extension add <path>`, **Then** extension is installed to `.specify/extensions/<id>/`
2. **Given** an installed extension, **When** I run `extension remove <id>`, **Then** extension folder is deleted and commands unregistered
3. **Given** an invalid path, **When** I run `extension add <path>`, **Then** it shows a helpful error

---

### User Story 4 - Preset List/Info (Priority: P1)

As a developer, I want to run `specify preset list` to see installed presets, so that I can understand my customization stack.

**Why this priority**: Most common preset operation - visibility into customizations.

**Independent Test**: Install a preset manually, run `specify preset list`, verify it appears with priority.

**Acceptance Scenarios**:

1. **Given** installed presets, **When** I run `preset list`, **Then** each shows ID, version, priority, and status
2. **Given** no presets, **When** I run `preset list`, **Then** it shows "No presets installed"
3. **Given** a preset ID, **When** I run `preset info <id>`, **Then** it shows full metadata including templates

---

### User Story 5 - Preset Add/Remove (Priority: P1)

As a developer, I want to install and remove presets via CLI, so that I can customize my SDD workflow.

**Why this priority**: Core preset lifecycle management.

**Independent Test**: Run `preset add <path>`, verify templates override core. Run `preset remove <id>`, verify core restored.

**Acceptance Scenarios**:

1. **Given** a local preset directory, **When** I run `preset add <path>`, **Then** preset is installed to `.specify/presets/<id>/`
2. **Given** an installed preset, **When** I run `preset remove <id>`, **Then** preset folder is deleted and core templates restored
3. **Given** a priority argument, **When** I run `preset add <path> --priority 5`, **Then** preset is installed with that priority

---

### User Story 6 - Enable/Disable Extensions and Presets (Priority: P2)

As a developer, I want to enable or disable extensions/presets without removing them, so that I can temporarily turn off functionality.

**Why this priority**: Useful for debugging - lower priority than core add/remove.

**Independent Test**: Disable an extension, verify commands unregistered but files remain. Enable it, verify commands restored.

**Acceptance Scenarios**:

1. **Given** an enabled extension, **When** I run `extension disable <id>`, **Then** its commands are unregistered
2. **Given** a disabled extension, **When** I run `extension enable <id>`, **Then** its commands are registered
3. **Given** a disabled preset, **When** I run `preset enable <id>`, **Then** its templates are used again

---

### User Story 7 - Priority Management (Priority: P2)

As a developer with multiple presets, I want to set priority order, so that I control which preset's overrides take precedence.

**Why this priority**: Only matters with multiple presets installed.

**Independent Test**: Install two presets, set different priorities, verify higher priority wins for overlapping templates.

**Acceptance Scenarios**:

1. **Given** a preset, **When** I run `preset priority <id> <number>`, **Then** the priority is updated
2. **Given** an extension, **When** I run `extension priority <id> <number>`, **Then** the priority is updated

---

### Edge Cases

- Extension with commands that conflict with existing commands
- Removing an extension that was already partially removed
- Invalid manifest.yml in extension/preset directory
- Running commands outside a spec-kit project

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST fix dynamic `require()` calls in extension.ts to use ESM-compatible imports
- **FR-002**: CLI MUST provide `specify extension list` showing all installed extensions
- **FR-003**: CLI MUST provide `specify extension add <path>` for local directory installation
- **FR-004**: CLI MUST provide `specify extension remove <id>` for uninstallation
- **FR-005**: CLI MUST provide `specify extension info <id>` for detailed metadata
- **FR-006**: CLI MUST provide `specify extension enable <id>` and `disable <id>`
- **FR-007**: CLI MUST provide `specify extension priority <id> <number>`
- **FR-008**: CLI MUST provide `specify preset list` showing all installed presets with priorities
- **FR-009**: CLI MUST provide `specify preset add <path>` for local directory installation
- **FR-010**: CLI MUST provide `specify preset remove <id>` for uninstallation
- **FR-011**: CLI MUST provide `specify preset info <id>` for detailed metadata
- **FR-012**: CLI MUST provide `specify preset enable <id>` and `disable <id>`
- **FR-013**: CLI MUST provide `specify preset priority <id> <number>`
- **FR-014**: All commands MUST display helpful error messages when run outside spec-kit project

### Key Entities

- **ExtensionManager**: Existing class - handles extension installation, removal, and state
- **PresetManager**: Existing class - handles preset installation, removal, and state
- **CLI Parser**: New code in cli.ts to route subcommands to manager methods

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `specify init` completes without ESM errors
- **SC-002**: All extension subcommands work as specified (add, remove, list, info, enable, disable, priority)
- **SC-003**: All preset subcommands work as specified (add, remove, list, info, enable, disable, priority)
- **SC-004**: All existing tests continue to pass
- **SC-005**: New CLI commands have corresponding tests

## Assumptions

- The backend classes (`ExtensionManager`, `PresetManager`) are correctly implemented
- Extensions/presets are installed from local directories (URL-based install is P3, out of scope)
- Catalog/search features are P3 (out of scope for this feature)

## Upstream Compatibility Constraint

Per user requirement: **Changes must maintain easy mergeability with the original github/spec-kit repository**.

This means:
1. **Minimal file changes**: Prefer small, targeted edits over large refactors
2. **No structural reorganization**: Keep files in their current locations, don't move code between files
3. **Additive patterns**: Add new functions rather than rewriting existing ones
4. **Clear separation**: CLI wiring code should be clearly separated from backend logic (already the case)
5. **Constitution VI compliance**: Changes must maintain 1:1 migration fidelity with Python version

This ensures future upstream improvements can be merged cleanly.
