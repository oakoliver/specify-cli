# CLI Command Contracts

## Extension Commands

### `specify extension list`

**Synopsis**: `specify extension list`  
**Description**: List all installed extensions with their status.  
**Arguments**: None  
**Options**: None  
**Output (success)**:
```
Installed extensions:

  ID               VERSION   PRIORITY   STATUS
  my-extension     1.0.0     0          enabled
  another-ext      0.2.1     5          disabled

2 extensions installed.
```
**Output (empty)**: `No extensions installed.`  
**Exit code**: 0  
**Errors**: Exits 1 if not in a spec-kit project.

---

### `specify extension add <path>`

**Synopsis**: `specify extension add <path> [--priority <n>]`  
**Description**: Install an extension from a local directory.  
**Arguments**:
- `<path>` (required): Path to extension directory containing manifest.yml  
**Options**:
- `--priority <n>`: Set priority (default: 0). Lower number = higher precedence.  
**Output (success)**: `Extension '<id>' installed successfully.`  
**Exit code**: 0  
**Errors**:
- `Extension directory not found: <path>` (exit 1)
- `Invalid extension manifest` (exit 1)
- `Extension '<id>' is not compatible with spec-kit <version>` (exit 1)

---

### `specify extension remove <id>`

**Synopsis**: `specify extension remove <id>`  
**Description**: Uninstall an extension and unregister its commands.  
**Arguments**:
- `<id>` (required): Extension identifier  
**Output (success)**: `Extension '<id>' removed successfully.`  
**Exit code**: 0  
**Errors**: `Extension not found: <id>` (exit 1)

---

### `specify extension info <id>`

**Synopsis**: `specify extension info <id>`  
**Description**: Show detailed metadata for an installed extension.  
**Arguments**:
- `<id>` (required): Extension identifier  
**Output (success)**:
```
Extension: my-extension
  Version:     1.0.0
  Description: A helpful extension
  Author:      user
  Priority:    0
  Status:      enabled
  Commands:    cmd1, cmd2
  Installed:   2026-03-28T12:00:00Z
```
**Exit code**: 0  
**Errors**: `Extension not found: <id>` (exit 1)

---

### `specify extension enable <id>`

**Synopsis**: `specify extension enable <id>`  
**Description**: Enable a disabled extension and re-register its commands.  
**Arguments**:
- `<id>` (required): Extension identifier  
**Output (success)**: `Extension '<id>' enabled.`  
**Exit code**: 0  
**Errors**: `Extension not found: <id>` (exit 1)

---

### `specify extension disable <id>`

**Synopsis**: `specify extension disable <id>`  
**Description**: Disable an extension without removing it. Unregisters its commands.  
**Arguments**:
- `<id>` (required): Extension identifier  
**Output (success)**: `Extension '<id>' disabled.`  
**Exit code**: 0  
**Errors**: `Extension not found: <id>` (exit 1)

---

### `specify extension priority <id> <number>`

**Synopsis**: `specify extension priority <id> <number>`  
**Description**: Set the priority of an installed extension.  
**Arguments**:
- `<id>` (required): Extension identifier
- `<number>` (required): Priority value (integer, lower = higher precedence)  
**Output (success)**: `Extension '<id>' priority set to <number>.`  
**Exit code**: 0  
**Errors**:
- `Extension not found: <id>` (exit 1)
- `Invalid priority value: <number>` (exit 1)

---

## Preset Commands

### `specify preset list`

**Synopsis**: `specify preset list`  
**Description**: List all installed presets with their priority and status.  
**Arguments**: None  
**Options**: None  
**Output (success)**:
```
Installed presets:

  ID               VERSION   PRIORITY   STATUS
  my-preset        1.0.0     0          enabled
  org-standards    0.3.0     5          enabled

2 presets installed.
```
**Output (empty)**: `No presets installed.`  
**Exit code**: 0  
**Errors**: Exits 1 if not in a spec-kit project.

---

### `specify preset add <path>`

**Synopsis**: `specify preset add <path> [--priority <n>]`  
**Description**: Install a preset from a local directory.  
**Arguments**:
- `<path>` (required): Path to preset directory containing manifest.yml  
**Options**:
- `--priority <n>`: Set priority (default: 0). Higher number = higher precedence.  
**Output (success)**: `Preset '<id>' installed successfully.`  
**Exit code**: 0  
**Errors**:
- `Preset directory not found: <path>` (exit 1)
- `Invalid preset manifest` (exit 1)

---

### `specify preset remove <id>`

**Synopsis**: `specify preset remove <id>`  
**Description**: Uninstall a preset and restore core template defaults.  
**Arguments**:
- `<id>` (required): Preset identifier  
**Output (success)**: `Preset '<id>' removed successfully.`  
**Exit code**: 0  
**Errors**: `Preset not found: <id>` (exit 1)

---

### `specify preset info <id>`

**Synopsis**: `specify preset info <id>`  
**Description**: Show detailed metadata for an installed preset.  
**Arguments**:
- `<id>` (required): Preset identifier  
**Output (success)**:
```
Preset: my-preset
  Version:     1.0.0
  Description: Custom templates for our org
  Author:      org
  Priority:    5
  Status:      enabled
  Templates:   plan-template.md, spec-template.md
  Installed:   2026-03-28T12:00:00Z
```
**Exit code**: 0  
**Errors**: `Preset not found: <id>` (exit 1)

---

### `specify preset enable <id>`

**Synopsis**: `specify preset enable <id>`  
**Description**: Enable a disabled preset.  
**Arguments**:
- `<id>` (required): Preset identifier  
**Output (success)**: `Preset '<id>' enabled.`  
**Exit code**: 0  
**Errors**: `Preset not found: <id>` (exit 1)

---

### `specify preset disable <id>`

**Synopsis**: `specify preset disable <id>`  
**Description**: Disable a preset without removing it.  
**Arguments**:
- `<id>` (required): Preset identifier  
**Output (success)**: `Preset '<id>' disabled.`  
**Exit code**: 0  
**Errors**: `Preset not found: <id>` (exit 1)

---

### `specify preset priority <id> <number>`

**Synopsis**: `specify preset priority <id> <number>`  
**Description**: Set the priority of an installed preset. Higher number = higher precedence.  
**Arguments**:
- `<id>` (required): Preset identifier
- `<number>` (required): Priority value (integer)  
**Output (success)**: `Preset '<id>' priority set to <number>.`  
**Exit code**: 0  
**Errors**:
- `Preset not found: <id>` (exit 1)
- `Invalid priority value: <number>` (exit 1)

---

## Common Error Contract

All extension and preset commands share these common errors:

| Condition | Message | Exit Code |
|-----------|---------|-----------|
| Not in spec-kit project | `Not a spec-kit project. Run 'specify init' first.` | 1 |
| Missing required argument | `Usage: specify <command> <subcommand> <args>` | 1 |
| Unknown subcommand | `Unknown <command> subcommand: '<sub>'. Run 'specify <command> --help' for usage.` | 1 |
