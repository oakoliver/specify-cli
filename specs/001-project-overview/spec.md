# Project Overview: Spec-Kit TypeScript Port

**Feature Branch**: `001-project-overview`  
**Created**: 2026-03-25  
**Status**: Draft  
**Input**: Port spec-kit CLI from Python to TypeScript/Bun for enterprise environments where Python installation is restricted

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Initialize SDD Project (Priority: P1)

As an enterprise developer in a Python-restricted environment, I want to initialize a new spec-driven development project using a TypeScript-based CLI, so that I can adopt SDD workflows without requiring Python installation.

**Why this priority**: This is the entry point for all spec-kit usage. Without project initialization, no other features can be used. Enterprise developers need this first to start any SDD workflow.

**Independent Test**: Can be fully tested by running `specify init my-project --ai copilot` and verifying the directory structure, templates, and agent commands are created correctly.

**Acceptance Scenarios**:

1. **Given** a developer with only Node.js/Bun installed (no Python), **When** they run `specify init my-project --ai copilot`, **Then** a new directory is created with `.specify/` folder containing templates, scripts, and agent configuration
2. **Given** an existing project directory, **When** they run `specify init . --ai claude --force`, **Then** spec-kit files are merged into the existing project without overwriting user files
3. **Given** a developer running init, **When** the command completes, **Then** the CLI displays a success message with next steps and available slash commands

---

### User Story 2 - Agent Command Registration (Priority: P1)

As a developer, I want the CLI to configure my AI coding agent (Copilot, Claude, Gemini, OpenCode, etc.) with spec-kit slash commands, so that I can use `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, and `/speckit.implement` within my agent.

**Why this priority**: Agent integration is essential for the SDD workflow. Without registered commands, developers cannot use spec-kit with their AI agents.

**Independent Test**: After init, open the project in VS Code with Copilot and verify `/speckit.specify` command is available and functional.

**Acceptance Scenarios**:

1. **Given** a project initialized with `--ai copilot`, **When** I open GitHub Copilot, **Then** all spec-kit slash commands appear in the command palette
2. **Given** a project initialized with `--ai claude`, **When** I start Claude Code, **Then** `/speckit.*` commands are registered and executable
3. **Given** a project initialized with `--ai opencode`, **When** I start opencode, **Then** `/speckit.*` commands are available in `.opencode/command/`

---

### User Story 3 - Check System Requirements (Priority: P2)

As a developer, I want to verify my system has the required tools installed, so that I can troubleshoot setup issues before starting development.

**Why this priority**: Helps users diagnose issues. Not critical for core workflow but important for onboarding and support.

**Independent Test**: Run `specify check` and verify it correctly reports installed/missing tools (git, AI agent CLIs).

**Acceptance Scenarios**:

1. **Given** a system with git and claude installed, **When** I run `specify check`, **Then** both tools are reported as available with checkmarks
2. **Given** a system missing the configured AI agent, **When** I run `specify check`, **Then** the missing tool is reported with installation instructions
3. **Given** a system with all required tools, **When** I run `specify check --fix`, **Then** any fixable issues are automatically resolved

---

### User Story 4 - Extension Management (Priority: P3)

As a developer, I want to install, remove, and manage spec-kit extensions, so that I can customize my SDD workflow with community-contributed functionality.

**Why this priority**: Extensions extend functionality but are not required for core SDD workflow. Can be implemented after core features.

**Independent Test**: Run `specify extension add <url>` and verify the extension is installed and its commands are registered.

**Acceptance Scenarios**:

1. **Given** a valid extension URL, **When** I run `specify extension add-from-url <url>`, **Then** the extension is downloaded, validated, and installed
2. **Given** an installed extension, **When** I run `specify extension remove <id>`, **Then** the extension and its commands are removed
3. **Given** a project with extensions, **When** I run `specify extension list`, **Then** all installed extensions are displayed with their status

---

### User Story 5 - Preset Management (Priority: P3)

As a developer, I want to install and manage presets that customize spec-kit templates and commands, so that I can adapt the SDD workflow to my organization's standards.

**Why this priority**: Presets customize behavior but are not required for core workflow. Can be implemented alongside extensions.

**Independent Test**: Run `specify preset add <url>` and verify templates are overridden according to preset configuration.

**Acceptance Scenarios**:

1. **Given** a valid preset URL, **When** I run `specify preset add-from-url <url>`, **Then** the preset is installed and its templates override defaults
2. **Given** multiple installed presets, **When** I run `specify preset priority <id> 5`, **Then** the preset's priority is updated and template resolution order changes
3. **Given** an installed preset, **When** I run `specify preset list`, **Then** all presets are shown with their priority order

---

### Edge Cases

- What happens when network is unavailable during template download? System should fall back to bundled templates with `--offline` flag or clear error message
- How does the system handle corrupted or invalid extension packages? Validate manifest before installation, provide clear error and rollback
- What happens when init is run in a git repository with uncommitted changes? Warn user but allow `--force` to proceed
- How does the system handle Windows vs Unix path separators? Use path normalization throughout

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST provide `specify init` command with all options from Python version (--ai, --script, --branch-numbering, --force, --here, --no-git, --offline, --ai-skills)
- **FR-002**: CLI MUST support all 20+ AI agents defined in the Python version's AGENT_CONFIG
- **FR-003**: CLI MUST create identical directory structure to Python version (.specify/, agent folders, templates, scripts)
- **FR-004**: CLI MUST provide `specify check` command to verify system requirements
- **FR-005**: CLI MUST provide `specify extension` subcommands (add, remove, list, enable, disable, priority, info, catalog)
- **FR-006**: CLI MUST provide `specify preset` subcommands (add, remove, list, enable, disable, priority, info, catalog)
- **FR-007**: CLI MUST use @oakoliver/* packages for terminal UI (bubbletea, bubbles, lipgloss, glamour, huh)
- **FR-008**: CLI MUST have zero runtime dependencies (devDependencies only)
- **FR-009**: CLI MUST work on Node.js 18+, Bun, and Deno without modification
- **FR-010**: CLI MUST provide both human-readable and JSON output formats (--json flag)
- **FR-011**: CLI MUST handle template downloads from GitHub releases with fallback to bundled assets
- **FR-012**: CLI MUST support both bash (sh) and PowerShell (ps) script generation

### Key Entities

- **Project**: A directory initialized with spec-kit, containing .specify/ folder and agent configuration
- **Agent**: An AI coding assistant configuration (copilot, claude, gemini, opencode, etc.) with specific command folder structure
- **Extension**: A modular add-on providing new commands and templates, installed in .specify/extensions/
- **Preset**: A template override package that customizes spec-kit behavior, installed in .specify/presets/
- **Template**: A markdown file with placeholders used to generate specs, plans, tasks, and checklists
- **Command**: A markdown file registered with an AI agent that defines a slash command's behavior

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Developers can initialize a spec-kit project in under 30 seconds using only Node.js/Bun (no Python required)
- **SC-002**: All 9 core slash commands work identically to Python version (/speckit.constitution, .specify, .plan, .tasks, .implement, .clarify, .analyze, .checklist, .taskstoissues)
- **SC-003**: 100% of init command options from Python version are supported
- **SC-004**: CLI passes all equivalent tests from Python test suite (ported to Bun test)
- **SC-005**: Package installs globally via npm/bun with single command (`npm install -g specify-cli`)
- **SC-006**: CLI produces identical directory structure and file contents as Python version
- **SC-007**: Total package size under 500KB unpacked (zero runtime deps)

## Assumptions

- Target users are developers in enterprise environments where Python is restricted but Node.js/Bun is permitted
- Users have Node.js 18+ or Bun 1.0+ already installed
- Users have git installed for repository initialization
- Network access to GitHub is available for template downloads (with offline fallback)
- The @oakoliver/* packages are production-ready and will be added as regular dependencies (they are zero-dep themselves)
- Maintaining feature parity with Python version is more important than adding new features
