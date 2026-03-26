# Feature Specification: Core Types and Agent Configuration

**Feature Branch**: `002-core-types`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: None (foundation layer)

## Overview

Define the foundational types, agent configurations, and shared utilities that all other features depend on. This is the data layer — no CLI, no UI, just pure TypeScript types and configuration objects.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent Configuration Registry (Priority: P1)

As a developer building spec-kit features, I need a complete registry of all 20+ supported AI agents with their folder structures and command formats, so that I can programmatically configure any agent.

**Why this priority**: Every other feature (init, extensions, presets) depends on knowing agent configurations. This is the foundation.

**Independent Test**: Import `AGENT_CONFIG` and verify it contains correct folder paths and formats for copilot, claude, gemini, opencode, codex, etc.

**Acceptance Scenarios**:

1. **Given** the agent registry is imported, **When** I access `AGENT_CONFIG['copilot']`, **Then** I get `{ folder: '.github/', commandsDir: 'agents/', format: 'markdown-agent' }`
2. **Given** the agent registry, **When** I iterate all agents, **Then** each has `folder`, `commandsDir`, `format`, and optionally `skillsDir` properties
3. **Given** an unknown agent name, **When** I look it up, **Then** I get `undefined` (not an error)

---

### User Story 2 - TypeScript Type Definitions (Priority: P1)

As a developer, I need complete type definitions for all spec-kit concepts (Project, Extension, Preset, Template, Command), so that I get full IntelliSense and compile-time safety.

**Why this priority**: Types enable safe development of all other features. They're the contract.

**Independent Test**: TypeScript compilation succeeds with strict mode. All types are exported from the main entry point.

**Acceptance Scenarios**:

1. **Given** a TypeScript project importing `@oakoliver/specify-cli`, **When** I use the types, **Then** I get full autocomplete for all properties
2. **Given** the exported types, **When** I check them, **Then** they match the structure defined in the Python version
3. **Given** an invalid type usage, **When** I compile, **Then** TypeScript reports the error at compile time

---

### User Story 3 - Init Options Configuration (Priority: P2)

As a developer, I need to persist and load init options from `.specify/init-options.json`, so that subsequent commands know how the project was configured.

**Why this priority**: Required for commands to know which agent, script type, and branch numbering mode were selected during init.

**Independent Test**: Save options with `saveInitOptions()`, load with `loadInitOptions()`, verify round-trip fidelity.

**Acceptance Scenarios**:

1. **Given** init options `{ ai: 'claude', script: 'sh', branchNumbering: 'sequential' }`, **When** I save and reload them, **Then** I get the exact same object
2. **Given** a project without `init-options.json`, **When** I call `loadInitOptions()`, **Then** I get sensible defaults
3. **Given** corrupted JSON in the file, **When** I call `loadInitOptions()`, **Then** I get an error with a clear message

---

### Edge Cases

- Agent with skills support (codex, kimi) vs agents with only commands
- Agents with custom command file extensions (.toml for gemini/tabnine)
- Handling undefined/null values in configuration objects
- JSON parsing errors in init-options.json

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST export `AGENT_CONFIG` object with all 20+ agents from Python version
- **FR-002**: System MUST export TypeScript interfaces for: `AgentConfig`, `InitOptions`, `ExtensionManifest`, `PresetManifest`, `Project`
- **FR-003**: System MUST provide `loadInitOptions(projectRoot: string)` function
- **FR-004**: System MUST provide `saveInitOptions(projectRoot: string, options: InitOptions)` function
- **FR-005**: System MUST export utility functions: `getAgentCommandsDir()`, `getAgentSkillsDir()`, `isAgentSupported()`

### Key Entities

- **AgentConfig**: Configuration for a single AI agent (folder, commandsDir, format, skillsDir)
- **InitOptions**: Saved project initialization options (ai, script, branchNumbering, aiSkills)
- **ExtensionManifest**: Extension metadata (id, name, version, commands, templates, hooks)
- **PresetManifest**: Preset metadata (id, name, version, templates, priority)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 20+ agents from Python AGENT_CONFIG are represented
- **SC-002**: TypeScript strict compilation passes with zero errors
- **SC-003**: 100% of exported types have JSDoc documentation
- **SC-004**: Round-trip serialization of InitOptions preserves all fields

## Assumptions

- Agent configurations are static (not loaded from remote sources)
- JSON is the serialization format for all config files
- All paths use forward slashes (normalized internally)
