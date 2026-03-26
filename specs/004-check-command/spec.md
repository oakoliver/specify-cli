# Feature Specification: Check Command

**Feature Branch**: `004-check-command`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: 002-core-types

## Overview

Implement the `specify check` command that validates the development environment has all required tools installed. This helps developers diagnose setup issues before starting work.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verify System Requirements (Priority: P1)

As a developer setting up spec-kit, I want to run `specify check` to see if my system has all required tools, so that I can fix any issues before starting development.

**Why this priority**: Helps users self-diagnose issues. Essential for support and onboarding.

**Independent Test**: Run `specify check` on a system with git installed, verify it reports git as available.

**Acceptance Scenarios**:

1. **Given** git is installed, **When** I run `specify check`, **Then** git shows with a green checkmark (✓)
2. **Given** claude is not installed, **When** I run `specify check`, **Then** claude shows with a red X and installation instructions
3. **Given** all tools are installed, **When** check completes, **Then** it displays "All checks passed"

---

### User Story 2 - Agent-Specific Checks (Priority: P2)

As a developer, I want check to verify my configured AI agent CLI is installed, so that I know if my agent integration will work.

**Why this priority**: Different agents have different CLI tools. Check should be context-aware.

**Independent Test**: In a project configured with `--ai claude`, run `specify check`, verify it checks for claude CLI.

**Acceptance Scenarios**:

1. **Given** a project initialized with `--ai copilot`, **When** I run `specify check`, **Then** it checks for `code` or `code-insiders` CLI
2. **Given** a project initialized with `--ai claude`, **When** I run `specify check`, **Then** it checks for `claude` CLI
3. **Given** no project context, **When** I run `specify check`, **Then** it checks only git (common requirement)

---

### User Story 3 - Fix Mode (Priority: P3)

As a developer, I want to run `specify check --fix` to automatically repair fixable issues, so that I don't have to manually resolve every problem.

**Why this priority**: Nice-to-have automation. Not critical for MVP.

**Independent Test**: Run `specify check --fix` when a script is missing execute permissions, verify it fixes the permission.

**Acceptance Scenarios**:

1. **Given** a script without execute permission, **When** I run `specify check --fix`, **Then** the permission is added
2. **Given** a missing `init-options.json`, **When** I run `specify check --fix`, **Then** it's created with defaults
3. **Given** an unfixable issue (tool not installed), **When** I run `specify check --fix`, **Then** it reports the issue without crashing

---

### Edge Cases

- Running check outside a spec-kit project
- Multiple versions of the same tool installed
- Tool installed but not in PATH
- Permission denied when trying to fix issues

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST provide `specify check` command
- **FR-002**: CLI MUST check for git availability
- **FR-003**: CLI MUST check for configured agent CLI (from init-options.json or --ai flag)
- **FR-004**: CLI MUST display styled output with checkmarks/X marks using @oakoliver/lipgloss
- **FR-005**: CLI MUST accept `--fix` flag to auto-repair fixable issues
- **FR-006**: CLI MUST show installation instructions for missing tools
- **FR-007**: CLI MUST exit with code 0 if all checks pass, non-zero otherwise

### Key Entities

- **ToolCheck**: A single check (tool name, check function, fix function, install instructions)
- **CheckResult**: Result of running a check (passed, failed, fixed, error)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Check completes in under 2 seconds
- **SC-002**: All supported agent CLIs have corresponding checks
- **SC-003**: Exit codes correctly indicate success/failure for CI usage
- **SC-004**: Installation instructions are accurate for each tool

## Assumptions

- Tools are checked via `which` (Unix) or `where` (Windows) commands
- Fix mode only repairs file-level issues, not missing tool installations
