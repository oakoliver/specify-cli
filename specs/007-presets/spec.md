# Feature Specification: Preset Management

**Feature Branch**: `007-presets`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: 002-core-types, 005-agent-system

## Overview

Implement the preset system that allows customization of spec-kit templates and commands without changing core functionality. Presets override defaults and can be stacked with priority ordering.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Preset (Priority: P1)

As a developer, I want to install a preset that customizes my SDD workflow, so that I can adapt spec-kit to my organization's standards.

**Why this priority**: Primary use case for presets. Must work before any other preset features.

**Independent Test**: Install a preset, verify its templates override core templates.

**Acceptance Scenarios**:

1. **Given** a valid preset URL, **When** I run `preset add-from-url <url>`, **Then** preset is installed to `.specify/presets/<id>/`
2. **Given** preset has template overrides, **When** installed, **Then** those templates take precedence over core
3. **Given** preset has command overrides, **When** installed, **Then** those commands are registered (replacing core versions)

---

### User Story 2 - Remove Preset (Priority: P1)

As a developer, I want to remove a preset to restore default behavior, so that I can undo customizations.

**Why this priority**: Clean removal required for preset lifecycle.

**Independent Test**: Install preset, remove it, verify core templates are restored.

**Acceptance Scenarios**:

1. **Given** an installed preset, **When** I run `preset remove <id>`, **Then** the preset folder is deleted
2. **Given** removal completes, **When** I check templates, **Then** core templates are used again
3. **Given** preset had command overrides, **When** removal completes, **Then** core commands are restored

---

### User Story 3 - Preset Priority (Priority: P2)

As a developer with multiple presets, I want to set priority order, so that I control which preset's overrides take precedence.

**Why this priority**: Multiple presets need conflict resolution.

**Independent Test**: Install two presets with overlapping templates, set priority, verify higher priority wins.

**Acceptance Scenarios**:

1. **Given** two presets with same template, **When** I set preset A priority to 5 and B to 10, **Then** preset B's template is used
2. **Given** I change priority, **When** I check template resolution, **Then** new priority is reflected
3. **Given** presets with non-overlapping templates, **When** I use them, **Then** both templates are available

---

### User Story 4 - List and Info (Priority: P2)

As a developer, I want to list installed presets and see their details, so that I can understand my customization stack.

**Why this priority**: Visibility for debugging and auditing.

**Independent Test**: Install presets, run `list` and `info`, verify correct output.

**Acceptance Scenarios**:

1. **Given** installed presets, **When** I run `list`, **Then** each shows ID, name, priority, and status
2. **Given** a preset ID, **When** I run `info <id>`, **Then** it shows full details including templates and commands
3. **Given** no presets, **When** I run `list`, **Then** it shows "No presets installed"

---

### User Story 5 - Search Preset Catalog (Priority: P3)

As a developer, I want to browse available presets from the catalog, so that I can discover community customizations.

**Why this priority**: Discovery feature. Nice-to-have after core works.

**Independent Test**: Run `catalog`, verify it shows community presets.

**Acceptance Scenarios**:

1. **Given** network access, **When** I run `catalog`, **Then** available presets are displayed
2. **Given** a search term, **When** I run `catalog <term>`, **Then** results are filtered
3. **Given** no network, **When** I run `catalog`, **Then** error message is shown

---

### Edge Cases

- Preset and extension both override same template
- Preset references templates that don't exist in core
- Circular priority assignments
- Preset with invalid manifest

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST provide `specify preset add <path>` for local directory/ZIP
- **FR-002**: CLI MUST provide `specify preset add-from-url <url>` for remote ZIP
- **FR-003**: CLI MUST provide `specify preset remove <id>`
- **FR-004**: CLI MUST provide `specify preset list`
- **FR-005**: CLI MUST provide `specify preset enable <id>` and `disable <id>`
- **FR-006**: CLI MUST provide `specify preset priority <id> <number>`
- **FR-007**: CLI MUST provide `specify preset info <id>`
- **FR-008**: CLI MUST provide `specify preset catalog [search]`
- **FR-009**: System MUST resolve templates by priority: project-local > presets (by priority) > extensions > core
- **FR-010**: System MUST store preset registry at `.specify/presets/.registry`

### Key Entities

- **PresetManager**: Main class handling all preset operations
- **PresetManifest**: Metadata from preset's manifest.json (id, name, version, templates, commands, priority)
- **PresetRegistry**: JSON file tracking installed presets and their state
- **TemplateResolver**: Resolves template path by walking priority stack

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Preset install completes in under 5 seconds
- **SC-002**: Template resolution correctly follows priority order
- **SC-003**: All preset subcommands work as specified
- **SC-004**: Multiple presets can coexist without conflicts

## Assumptions

- Presets are distributed as ZIP files or local directories
- Preset manifest follows a defined JSON schema
- Higher priority number = higher precedence (10 beats 5)
- Template resolution happens at runtime, not install time
