# Research: Agent Registration System

**Feature**: 005-agent-system
**Date**: 2026-03-25

## Research Questions

### Q1: How to parse YAML frontmatter without dependencies?

**Decision**: Implement simple key-value YAML parser

**Rationale**: Full YAML is complex (nested objects, arrays, anchors), but command frontmatter only uses:
- Simple key-value pairs (`description: "some text"`)
- Occasionally nested objects (`handoffs:` with child items)
- No anchors, no flow syntax, no complex types

**Implementation**:
```typescript
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  
  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;
    
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    
    // Array item (starts with -)
    if (trimmed.startsWith('- ') && currentArray) {
      currentArray.push(parseYamlValue(trimmed.slice(2)));
      continue;
    }
    
    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      
      if (value === '') {
        // Start of array or nested object
        currentKey = key;
        currentArray = [];
        result[key] = currentArray;
      } else {
        result[key] = parseYamlValue(value);
        currentArray = null;
      }
    }
  }
  
  return result;
}
```

**Alternatives Considered**:
- `js-yaml` package: Would violate zero-dependency principle
- JSON5 instead of YAML: Would require changing existing templates

---

### Q2: How to generate valid TOML without dependencies?

**Decision**: Simple string builder for flat TOML

**Rationale**: Gemini/Tabnine TOML only needs:
- `description = "string"`
- `prompt = """multiline string"""`

No tables, no nested structures, no arrays.

**Implementation**:
```typescript
function escapeTomlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function toToml(obj: { description: string; prompt: string }): string {
  const desc = escapeTomlString(obj.description);
  const prompt = obj.prompt;
  
  // Use basic strings for description (single line)
  // Use multiline literal strings for prompt (preserves newlines)
  return `description = "${desc}"\n\nprompt = """\n${prompt}\n"""`;
}
```

**Alternatives Considered**:
- `@iarna/toml`: Would violate zero-dependency principle
- JSON for Gemini: Would break Gemini's expected format

---

### Q3: How should Copilot companion files be generated?

**Decision**: Generate both `.agent.md` and `.prompt.md` for each command

**Rationale**: Copilot expects:
1. `.github/agents/speckit.specify.agent.md` - The agent definition
2. `.github/prompts/speckit.specify.prompt.md` - The prompt template (references agent)

**Implementation**:
```typescript
async function registerCopilotCommand(
  projectRoot: string,
  commandName: string,
  content: string
): Promise<string[]> {
  const agentPath = `${projectRoot}/.github/agents/${commandName}.agent.md`;
  const promptPath = `${projectRoot}/.github/prompts/${commandName}.prompt.md`;
  
  // Write agent file
  await writeFile(agentPath, content);
  
  // Write companion prompt file
  const promptContent = `---
mode: agent
agent: ${commandName}
---

See @${commandName}.agent.md for full instructions.
`;
  await writeFile(promptPath, promptContent);
  
  return [agentPath, promptPath];
}
```

---

### Q4: How to handle skill-based agents (Codex, Kimi)?

**Decision**: Create directory per command with SKILL.md inside

**Rationale**: Codex and Kimi use agentskills.io format which expects:
```
.agents/skills/speckit.specify/SKILL.md
```

The SKILL.md has different frontmatter format:
```yaml
name: speckit.specify
description: Create a feature specification
```

**Implementation**:
```typescript
async function registerSkillCommand(
  projectRoot: string,
  agent: string,
  commandName: string,
  content: string
): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  const skillDir = `${projectRoot}/${config.dir}/${commandName}`;
  const skillPath = `${skillDir}/SKILL.md`;
  
  await mkdir(skillDir, { recursive: true });
  
  // Convert to SKILL.md format
  const { frontmatter, body } = parseFrontmatter(content);
  const skillFrontmatter = {
    name: commandName,
    description: frontmatter.description || '',
  };
  
  const skillContent = renderFrontmatter(skillFrontmatter, body);
  await writeFile(skillPath, skillContent);
  
  return skillPath;
}
```

---

### Q5: How to track registered commands for unregistration?

**Decision**: Return `RegisteredCommands` record from `registerCommands()`

**Rationale**: Caller (extension manager, init command) stores this in registry and passes it back to `unregisterCommands()`.

**Implementation**:
```typescript
interface RegisteredCommands {
  [agentName: string]: string[]; // List of file paths created
}

function registerCommands(
  agent: string,
  commands: CommandDefinition[],
  projectRoot: string,
  sourceId: string // "core" | extension ID | preset ID
): Promise<RegisteredCommands> {
  // Returns: { "copilot": [".github/agents/speckit.specify.agent.md", ...] }
}

function unregisterCommands(
  registered: RegisteredCommands,
  projectRoot: string
): Promise<void> {
  // Deletes all files in registered
}
```

---

## Summary

All research questions resolved. Ready for Phase 1 design.

| Question | Decision | Complexity |
|----------|----------|------------|
| YAML parsing | Simple key-value parser | Low |
| TOML generation | String builder | Low |
| Copilot companions | Generate both files | Low |
| Skill-based agents | Directory per command | Low |
| Command tracking | Return RegisteredCommands | Low |
