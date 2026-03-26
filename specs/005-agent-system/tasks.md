# Tasks: Agent Registration System

**Feature**: 005-agent-system
**Branch**: `005-agent-system`
**Plan**: [plan.md](./plan.md)
**Status**: COMPLETE (119 tests passing)

## Task Breakdown

### Task 1: Implement YAML Frontmatter Parser (P1)
**Estimate**: 30 min | **Status**: COMPLETE

**Acceptance Criteria**:
- [x] `parseFrontmatter(content)` returns `{ frontmatter, body }`
- [x] Handles content with no frontmatter (returns empty object)
- [x] Handles simple key-value pairs
- [x] Handles array values (for handoffs)
- [x] Handles quoted strings with special characters
- [x] `renderFrontmatter(frontmatter, body)` produces valid markdown

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 2: Implement TOML Generator (P1)
**Estimate**: 20 min | **Status**: COMPLETE

**Acceptance Criteria**:
- [x] `toToml({ description, prompt })` returns valid TOML string
- [x] Single-line descriptions use basic strings
- [x] Multi-line prompts use literal strings (`"""`)
- [x] Special characters are properly escaped

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 3: Implement Markdown Command Registration (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `registerMarkdownCommand()` creates file in correct directory
- [ ] Creates agent directory if it doesn't exist
- [ ] Handles Claude format (`.md`)
- [ ] Handles Cursor format (`.md`)
- [ ] Handles OpenCode format (`.md`)
- [ ] Returns file path created

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 4: Implement Copilot Command Registration (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Creates `.agent.md` file in `.github/agents/`
- [ ] Creates companion `.prompt.md` file in `.github/prompts/`
- [ ] Prompt file references the agent file
- [ ] Returns both file paths

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 5: Implement TOML Command Registration (P2)
**Estimate**: 20 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `registerTomlCommand()` creates `.toml` file
- [ ] Handles Gemini format
- [ ] Handles Tabnine format
- [ ] Extracts description from frontmatter
- [ ] Converts body to prompt field

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 6: Implement Skill-based Command Registration (P2)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Creates `<command>/SKILL.md` directory structure
- [ ] Handles Codex format (`.agents/skills/`)
- [ ] Handles Kimi format (`.kimi/skills/`)
- [ ] Uses agentskills.io frontmatter format
- [ ] Returns skill directory path

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 7: Implement CommandRegistrar Class (P1)
**Estimate**: 30 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `registerCommands(agent, commands, projectRoot, sourceId)` works for all agents
- [ ] Routes to correct format handler based on agent config
- [ ] Returns `RegisteredCommands` record
- [ ] Tracks source ID for each registered command

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 8: Implement Command Unregistration (P2)
**Estimate**: 20 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] `unregisterCommands(registered, projectRoot)` deletes all files
- [ ] Handles already-deleted files gracefully (idempotent)
- [ ] Cleans up empty directories for skill-based agents
- [ ] Removes Copilot companion files

**Files**:
- `src/registrar.ts` - Implementation
- `tests/registrar.test.ts` - Tests

---

### Task 9: Export and Integration (P1)
**Estimate**: 10 min | **Status**: Pending

**Acceptance Criteria**:
- [ ] Export all public APIs from `src/index.ts`
- [ ] TypeScript compilation passes
- [ ] All tests pass
- [ ] JSDoc documentation on public functions

**Files**:
- `src/index.ts` - Exports
- `src/registrar.ts` - JSDoc comments

---

## Summary

| Priority | Tasks | Estimated Time |
|----------|-------|----------------|
| P1 | 1, 2, 3, 4, 7, 9 | 2h 30min |
| P2 | 5, 6, 8 | 1h 10min |
| **Total** | 9 tasks | ~3h 40min |

## Test Coverage Target

Match Python's `test_extensions.py` CommandRegistrar tests:
- `test_parse_frontmatter_valid`
- `test_parse_frontmatter_no_frontmatter`
- `test_parse_frontmatter_non_mapping_returns_empty_dict`
- `test_render_frontmatter`
- `test_render_frontmatter_unicode`
- `test_register_commands_for_claude`
- `test_register_commands_for_copilot`
- `test_copilot_companion_prompt_created`
- `test_command_with_aliases`
- `test_codex_skill_registration_writes_skill_frontmatter`
- `test_unregister_commands_for_codex_skills_uses_mapped_names`
