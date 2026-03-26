# Tasks: Init Command

**Feature**: 003-init-command
**Branch**: `003-init-command`
**Plan**: [plan.md](./plan.md)

## Task Breakdown

### Task 1: Create CLI Entry Point (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `src/cli.ts` parses command line arguments
- [ ] Supports `specify init <project-name>`
- [ ] Supports all flags: --ai, --here, --force, --script, --branch-numbering, --no-git, --offline, --ai-skills
- [ ] Shows help with `specify --help` or `specify init --help`
- [ ] Handles `.` as project name (current directory)

**Files**:
- `src/cli.ts` - CLI entry point

---

### Task 2: Create Template Bundling System (P1)
**Estimate**: 45 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Bundle all templates in `templates/` directory
- [ ] `getTemplatesDir()` returns correct path at runtime
- [ ] `copyTemplates(source, dest)` copies directory recursively
- [ ] Template placeholders are replaced during copy
- [ ] Scripts have correct permissions (executable)

**Files**:
- `src/templates.ts` - Template utilities
- `templates/` - Bundled templates directory

---

### Task 3: Bundle Command Templates (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Include all 9 command templates (specify, plan, tasks, implement, clarify, analyze, checklist, constitution, taskstoissues)
- [ ] Templates are in markdown format with frontmatter
- [ ] Placeholder tokens: `{ARGS}`, `{SCRIPT}` are used

**Files**:
- `templates/commands/*.md` - Command templates

---

### Task 4: Bundle Shell Scripts (P1)
**Estimate**: 20 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Include bash scripts: create-new-feature.sh, setup-plan.sh, check-prerequisites.sh, common.sh, update-agent-context.sh
- [ ] Include powershell equivalents
- [ ] Scripts are executable after copy

**Files**:
- `templates/scripts/bash/*.sh`
- `templates/scripts/powershell/*.ps1`

---

### Task 5: Bundle Other Templates (P1)
**Estimate**: 20 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] spec-template.md
- [ ] plan-template.md
- [ ] tasks-template.md
- [ ] checklist-template.md
- [ ] constitution-template.md
- [ ] agent-file-template.md

**Files**:
- `templates/files/*.md`

---

### Task 6: Implement TUI Components (P2)
**Estimate**: 45 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] ASCII banner with SPECIFY title
- [ ] Step progress display with checkmarks
- [ ] Success/error message styling
- [ ] Uses @oakoliver/lipgloss for all styling

**Files**:
- `src/ui.ts` - TUI components

---

### Task 7: Implement Interactive Agent Selection (P2)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Shows fuzzy-filterable list of all 23 agents
- [ ] Uses @oakoliver/huh Select component
- [ ] Returns selected agent name
- [ ] Skipped when --ai flag is provided

**Files**:
- `src/init.ts` - Uses huh for selection

---

### Task 8: Implement Init Command Core Logic (P1)
**Estimate**: 60 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Creates project directory (or uses current with --here)
- [ ] Creates .specify/ structure with all subdirectories
- [ ] Copies templates to .specify/templates/
- [ ] Copies scripts to .specify/scripts/
- [ ] Creates empty specs/ directory
- [ ] Saves init-options.json
- [ ] Registers commands for selected agent

**Files**:
- `src/init.ts` - Main init implementation

---

### Task 9: Implement Git Initialization (P2)
**Estimate**: 20 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Runs `git init` unless --no-git
- [ ] Appends to existing .gitignore (doesn't replace)
- [ ] Handles missing git gracefully (warning, not error)

**Files**:
- `src/init.ts` - Git init logic

---

### Task 10: Implement --here Mode (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `specify init .` initializes in current directory
- [ ] `specify init --here` is equivalent
- [ ] Prompts for confirmation if directory not empty (unless --force)
- [ ] Merges with existing files (doesn't delete)

**Files**:
- `src/init.ts` - Here mode logic

---

### Task 11: Write Tests (P1)
**Estimate**: 60 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Test CLI argument parsing
- [ ] Test template copying
- [ ] Test directory structure creation
- [ ] Test init-options.json creation
- [ ] Test command registration integration
- [ ] Test --here mode
- [ ] Test --force mode

**Files**:
- `tests/init.test.ts` - Init command tests

---

### Task 12: Export and Integration (P1)
**Estimate**: 15 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Export init function from src/index.ts
- [ ] Add "bin" entry to package.json
- [ ] TypeScript compilation passes
- [ ] All tests pass

**Files**:
- `src/index.ts` - Exports
- `package.json` - Bin entry

---

## Summary

| Priority | Tasks | Estimated Time |
|----------|-------|----------------|
| P1 | 1, 2, 3, 4, 5, 8, 10, 11, 12 | 5h 30min |
| P2 | 6, 7, 9 | 1h 35min |
| **Total** | 12 tasks | ~7h |

## Test Coverage Target

Match Python's test scenarios:
- `test_init_creates_project_directory`
- `test_init_creates_specify_structure`
- `test_init_registers_commands_for_agent`
- `test_init_saves_options`
- `test_init_here_mode`
- `test_init_force_mode`
- `test_init_no_git_flag`
- `test_init_offline_mode`
