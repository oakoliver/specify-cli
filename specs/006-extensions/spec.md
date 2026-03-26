# Feature Specification: Extension Management

**Feature Branch**: `006-extensions`  
**Created**: 2026-03-25  
**Status**: Draft  
**Depends On**: 002-core-types, 005-agent-system

## Overview

Implement the extension system that allows community-contributed functionality to be added to spec-kit. Extensions can provide new commands, templates, and hooks. This feature covers installation, removal, listing, and priority management.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Extension from URL (Priority: P1)

As a developer, I want to run `specify extension add-from-url <url>` to install a community extension, so that I can add new capabilities to my SDD workflow.

**Why this priority**: Primary way to add extensions. URL-based installation is most flexible.

**Independent Test**: Run `specify extension add-from-url https://github.com/user/spec-kit-ext/archive/main.zip`, verify extension is installed and commands registered.

**Acceptance Scenarios**:

1. **Given** a valid extension ZIP URL, **When** I run `add-from-url`, **Then** extension is downloaded, extracted, and installed to `.specify/extensions/<id>/`
2. **Given** installation succeeds, **When** I check `.specify/extensions/.registry`, **Then** the extension is listed with its metadata
3. **Given** extension has commands, **When** installation completes, **Then** commands are registered for all configured agents

---

### User Story 2 - Remove Extension (Priority: P1)

As a developer, I want to run `specify extension remove <id>` to uninstall an extension, so that I can clean up extensions I no longer need.

**Why this priority**: Clean removal is essential for extension lifecycle management.

**Independent Test**: Install extension, then remove it, verify all files and commands are deleted.

**Acceptance Scenarios**:

1. **Given** an installed extension, **When** I run `remove <id>`, **Then** the extension folder is deleted
2. **Given** removal completes, **When** I check the registry, **Then** the extension is no longer listed
3. **Given** extension had commands, **When** removal completes, **Then** its commands are unregistered from all agents

---

### User Story 3 - List Installed Extensions (Priority: P2)

As a developer, I want to run `specify extension list` to see all installed extensions, so that I can audit what's in my project.

**Why this priority**: Visibility into what's installed. Important for debugging and auditing.

**Independent Test**: Install two extensions, run `list`, verify both appear with correct metadata.

**Acceptance Scenarios**:

1. **Given** installed extensions, **When** I run `list`, **Then** each extension shows ID, name, version, and status
2. **Given** no extensions installed, **When** I run `list`, **Then** it shows "No extensions installed"
3. **Given** a disabled extension, **When** I run `list`, **Then** it shows with "disabled" status

---

### User Story 4 - Enable/Disable Extension (Priority: P2)

As a developer, I want to enable or disable extensions without removing them, so that I can temporarily turn off functionality.

**Why this priority**: Useful for debugging or temporarily disabling problematic extensions.

**Independent Test**: Disable an extension, verify its commands are unregistered but files remain.

**Acceptance Scenarios**:

1. **Given** an enabled extension, **When** I run `disable <id>`, **Then** its commands are unregistered
2. **Given** a disabled extension, **When** I run `enable <id>`, **Then** its commands are registered
3. **Given** a disabled extension, **When** I check registry, **Then** it shows `enabled: false`

---

### User Story 5 - Search Extension Catalog (Priority: P3)

As a developer, I want to run `specify extension catalog` to browse available extensions, so that I can discover useful add-ons.

**Why this priority**: Discovery feature. Nice-to-have after core functionality works.

**Independent Test**: Run `catalog`, verify it shows extensions from the community catalog.

**Acceptance Scenarios**:

1. **Given** network access, **When** I run `catalog`, **Then** it shows available extensions with descriptions
2. **Given** a search term, **When** I run `catalog <term>`, **Then** results are filtered to matches
3. **Given** no network, **When** I run `catalog`, **Then** it shows a helpful error message

---

### Edge Cases

- Extension with conflicting command names
- Extension requires a newer spec-kit version
- Download fails mid-way
- Invalid manifest.json in extension
- Extension with circular dependencies

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CLI MUST provide `specify extension add <path>` for local directory/ZIP
- **FR-002**: CLI MUST provide `specify extension add-from-url <url>` for remote ZIP
- **FR-003**: CLI MUST provide `specify extension remove <id>`
- **FR-004**: CLI MUST provide `specify extension list`
- **FR-005**: CLI MUST provide `specify extension enable <id>` and `disable <id>`
- **FR-006**: CLI MUST provide `specify extension priority <id> <number>`
- **FR-007**: CLI MUST provide `specify extension info <id>`
- **FR-008**: CLI MUST provide `specify extension catalog [search]`
- **FR-009**: System MUST validate extension manifest before installation
- **FR-010**: System MUST store extension registry at `.specify/extensions/.registry`
- **FR-011**: System MUST register extension commands with all configured agents

### Key Entities

- **ExtensionManager**: Main class handling all extension operations
- **ExtensionManifest**: Metadata from extension's manifest.json (id, name, version, commands, templates, hooks)
- **ExtensionRegistry**: JSON file tracking installed extensions and their state

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Extension install completes in under 10 seconds for typical extensions
- **SC-002**: All extension subcommands work as specified
- **SC-003**: Extension commands are correctly registered/unregistered
- **SC-004**: Registry survives corruption (validates on load)

## Assumptions

- Extensions are distributed as ZIP files or local directories
- Extension manifest follows a defined JSON schema
- Catalog is fetched from GitHub's spec-kit repository
- Extensions cannot modify core spec-kit files
