# Feature Specification: Agent Registration System

**Feature Branch**: `005-agent-system`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: 002-core-types

## Overview

Implement the system that registers, manages, and formats slash commands for different AI coding agents. Each agent has different folder structures, file formats, and naming conventions. This module handles all the differences.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register Commands for Agent (Priority: P1)

As a developer building spec-kit, I need to register a set of commands (specify, plan, tasks, implement, etc.) for a specific agent, so that the commands appear in the correct folder with correct format.

**Why this priority**: Core functionality. Every init, extension add, and preset add uses this.

**Independent Test**: Call `registerCommands('copilot', commands, projectRoot)`, verify files appear in `.github/agents/` with correct `.agent.md` extension.

**Acceptance Scenarios**:

1. **Given** copilot agent and commands, **When** I register them, **Then** files are created in `.github/agents/` with `speckit.*.agent.md` names
2. **Given** claude agent and commands, **When** I register them, **Then** files are created in `.claude/commands/` with `speckit.*.md` names
3. **Given** gemini agent and commands, **When** I register them, **Then** files are created in `.gemini/commands/` with TOML format

---

### User Story 2 - Parse and Render Frontmatter (Priority: P1)

As a developer, I need to parse YAML frontmatter from command templates and render it back, so that I can modify command metadata programmatically.

**Why this priority**: Frontmatter contains command description, handoffs, and other metadata.

**Independent Test**: Parse frontmatter from a command file, modify it, render back, verify output matches expected format.

**Acceptance Scenarios**:

1. **Given** a markdown file with YAML frontmatter, **When** I parse it, **Then** I get a `{ frontmatter, body }` object
2. **Given** a frontmatter object and body, **When** I render it, **Then** I get a valid markdown string with `---` delimiters
3. **Given** a file without frontmatter, **When** I parse it, **Then** frontmatter is empty object, body is entire content

---

### User Story 3 - Unregister Commands (Priority: P2)

As a developer, when an extension is removed, I need to unregister its commands from all agents, so that stale commands don't remain.

**Why this priority**: Clean uninstallation prevents confusion and conflicts.

**Independent Test**: Register commands from extension, then unregister, verify files are deleted.

**Acceptance Scenarios**:

1. **Given** registered commands from extension "my-ext", **When** I unregister "my-ext", **Then** all its command files are deleted
2. **Given** overlapping commands from extension and core, **When** I unregister extension, **Then** core commands are restored
3. **Given** no commands from source, **When** I unregister, **Then** no error occurs (idempotent)

---

### User Story 4 - Format Conversion (Priority: P2)

As a developer, I need commands to be converted to the correct format for each agent (Markdown, TOML, SKILL.md), so that each agent can parse them.

**Why this priority**: Gemini and Tabnine use TOML. Codex uses SKILL.md in skill directories.

**Independent Test**: Convert a markdown command to TOML format for gemini, verify output is valid TOML.

**Acceptance Scenarios**:

1. **Given** a markdown command, **When** converted for gemini, **Then** output is valid TOML with `description` and `prompt` fields
2. **Given** a markdown command, **When** converted for codex with skills mode, **Then** it becomes `speckit-specify/SKILL.md` structure
3. **Given** a command with handoffs, **When** converted, **Then** handoffs are preserved in the output format

---

### Edge Cases

- Agent folder doesn't exist (should be created)
- Command file already exists from different source (handle priority/override)
- Invalid characters in command names
- Very long command content exceeding file system limits

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide `registerCommands(agent, commands, projectRoot)` function
- **FR-002**: System MUST provide `unregisterCommands(registeredCommands, projectRoot)` function
- **FR-003**: System MUST provide `parseFrontmatter(content)` function returning `{ frontmatter, body }`
- **FR-004**: System MUST provide `renderFrontmatter(frontmatter, body)` function returning markdown string
- **FR-005**: System MUST handle Markdown format (copilot, claude, cursor, opencode, etc.)
- **FR-006**: System MUST handle TOML format (gemini, tabnine)
- **FR-007**: System MUST handle SKILL.md format (codex, kimi, agy when in skills mode)
- **FR-008**: System MUST create agent folders if they don't exist
- **FR-009**: System MUST track registered commands by source (core, extension ID, preset ID)

### Key Entities

- **CommandRegistrar**: Main class handling registration and unregistration
- **CommandFormat**: Enum of supported formats (markdown, toml, skill)
- **RegisteredCommands**: Record of { agentName: commandPaths[] } for tracking what was registered

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 20+ agents can have commands registered correctly
- **SC-002**: Format conversion produces valid output for each target format
- **SC-003**: Unregistration removes all files without leaving orphans
- **SC-004**: Round-trip parse/render preserves frontmatter content

## Assumptions

- Command names follow `speckit.<name>` convention
- Each command file contains one command
- Priority handling uses file replacement (higher priority overwrites)
