# Feature Specification: Init Command

**Feature Branch**: `003-init-command`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: 002-core-types

## Overview

Implement the `specify init` command that bootstraps a new spec-driven development project. This is the primary entry point for spec-kit — it creates directory structure, copies templates, configures the AI agent, and optionally initializes git.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create New Project (Priority: P1)

As an enterprise developer, I want to run `specify init my-project --ai copilot` to create a new SDD project, so that I can start using spec-driven development immediately.

**Why this priority**: This is the most common use case — creating a fresh project.

**Independent Test**: Run `specify init test-project --ai copilot`, verify directory structure matches Python version output.

**Acceptance Scenarios**:

1. **Given** an empty parent directory, **When** I run `specify init my-project --ai copilot`, **Then** a new `my-project/` directory is created with `.specify/` and `.github/` folders
2. **Given** the init completes, **When** I inspect `.specify/`, **Then** it contains `templates/`, `scripts/`, `memory/`, and `init-options.json`
3. **Given** the init completes, **When** I inspect `.github/agents/`, **Then** it contains all `speckit.*.agent.md` command files

---

### User Story 2 - Initialize in Current Directory (Priority: P1)

As a developer with an existing project, I want to run `specify init . --ai claude` or `specify init --here --ai claude` to add spec-kit to my current directory.

**Why this priority**: Brownfield projects need in-place initialization without creating a subdirectory.

**Independent Test**: In an existing directory with files, run `specify init . --ai claude --force`, verify spec-kit files are added without destroying existing files.

**Acceptance Scenarios**:

1. **Given** an existing project directory, **When** I run `specify init . --ai claude`, **Then** spec-kit files are merged into the directory
2. **Given** an existing `.gitignore`, **When** init runs, **Then** spec-kit entries are appended (not replaced)
3. **Given** `--force` flag, **When** init runs in a non-empty directory, **Then** it proceeds without confirmation prompt

---

### User Story 3 - Interactive TUI Experience (Priority: P1)

As a developer, I want to see a beautiful terminal UI during init (progress steps, styled output, success message), so that I know what's happening and feel confident the setup is correct.

**Why this priority**: The TUI experience is what differentiates this port. Uses @oakoliver/bubbletea, lipgloss, huh.

**Independent Test**: Run init and verify styled output appears with step indicators, checkmarks, and the ASCII banner.

**Acceptance Scenarios**:

1. **Given** init starts, **When** the banner displays, **Then** it shows the SPECIFY ASCII art in styled colors
2. **Given** init is running, **When** each step completes, **Then** a checkmark (✓) appears next to the step name
3. **Given** init completes, **When** the summary displays, **Then** it shows "Project ready" with next steps

---

### User Story 4 - Agent Selection (Priority: P2)

As a developer, I want to select my AI agent interactively if I don't specify `--ai`, so that I can see all options and choose the right one.

**Why this priority**: Interactive selection improves discoverability of supported agents.

**Independent Test**: Run `specify init my-project` without `--ai`, verify interactive select prompt appears using @oakoliver/huh.

**Acceptance Scenarios**:

1. **Given** no `--ai` flag, **When** init runs, **Then** an interactive select list shows all supported agents
2. **Given** the select prompt, **When** I filter by typing, **Then** the list filters to matching agents
3. **Given** I select an agent, **When** I press Enter, **Then** init continues with that agent

---

### User Story 5 - Offline Mode (Priority: P2)

As an enterprise developer behind a firewall, I want to use `--offline` to skip GitHub template downloads, so that init works without network access.

**Why this priority**: Enterprise environments may block GitHub. Bundled templates provide fallback.

**Independent Test**: Run `specify init my-project --ai copilot --offline`, verify it succeeds without any network calls.

**Acceptance Scenarios**:

1. **Given** `--offline` flag, **When** init runs, **Then** bundled templates are used (no HTTP requests)
2. **Given** `--offline` flag, **When** init completes, **Then** output shows "Using bundled assets"
3. **Given** no network and no `--offline` flag, **When** init fails to fetch, **Then** it falls back to bundled assets with a warning

---

### Edge Cases

- Project name contains special characters or spaces
- Target directory already contains `.specify/` folder
- Disk is full during template extraction
- Git initialization fails (git not installed)
- Invalid agent name provided with `--ai`

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST accept `specify init <project-name>` with optional project name
- **FR-002**: CLI MUST accept `--ai <agent>` flag with all 20+ supported agents
- **FR-003**: CLI MUST accept `--here` or `.` to initialize in current directory
- **FR-004**: CLI MUST accept `--force` to skip confirmation in non-empty directories
- **FR-005**: CLI MUST accept `--script sh|ps` for shell script type
- **FR-006**: CLI MUST accept `--branch-numbering sequential|timestamp`
- **FR-007**: CLI MUST accept `--no-git` to skip git initialization
- **FR-008**: CLI MUST accept `--offline` to use bundled templates
- **FR-009**: CLI MUST accept `--ai-skills` to generate SKILL.md files for skill-based agents
- **FR-010**: CLI MUST display styled TUI output using @oakoliver/lipgloss
- **FR-011**: CLI MUST show interactive agent selection using @oakoliver/huh when --ai not provided
- **FR-012**: CLI MUST create identical directory structure to Python version
- **FR-013**: CLI MUST save init options to `.specify/init-options.json`

### Key Entities

- **Project**: The directory being initialized with all spec-kit files
- **Template Bundle**: The set of files copied during initialization
- **Step Tracker**: UI component showing progress through init steps

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Init completes in under 5 seconds for offline mode
- **SC-002**: Generated directory structure matches Python version exactly
- **SC-003**: All 9 slash commands are registered for the selected agent
- **SC-004**: TUI displays correctly in terminals with 80+ column width
- **SC-005**: Init works on Node.js 18+, Bun 1.0+, and Deno

## Assumptions

- Templates are bundled within the npm package (no external downloads required for offline mode)
- User has write permissions in the target directory
- Terminal supports ANSI escape sequences for styling
