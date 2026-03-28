# Quickstart: CLI Commands Implementation

## Prerequisites

You must be inside an initialized spec-kit project (`specify init` completed).

## Extension Commands

```bash
# List installed extensions
specify extension list

# Get detailed info about an extension
specify extension info <extension-id>

# Install extension from local directory
specify extension add <path-to-extension>

# Install with custom priority (lower number = higher precedence)
specify extension add <path> --priority 5

# Remove an extension
specify extension remove <extension-id>

# Temporarily disable an extension (keeps files, unregisters commands)
specify extension disable <extension-id>

# Re-enable a disabled extension
specify extension enable <extension-id>

# Change extension priority
specify extension priority <extension-id> <number>
```

## Preset Commands

```bash
# List installed presets (shows priority order)
specify preset list

# Get detailed info about a preset
specify preset info <preset-id>

# Install preset from local directory
specify preset add <path-to-preset>

# Install with custom priority (higher number = higher precedence)
specify preset add <path> --priority 5

# Remove a preset
specify preset remove <preset-id>

# Temporarily disable a preset
specify preset disable <preset-id>

# Re-enable a disabled preset
specify preset enable <preset-id>

# Change preset priority (affects template resolution order)
specify preset priority <preset-id> <number>
```

## Examples

### Installing and Managing Extensions

```bash
# Clone an extension repository locally
git clone https://github.com/user/spec-kit-review.git /tmp/spec-kit-review

# Install it into the current project
specify extension add /tmp/spec-kit-review

# Verify installation
specify extension list

# Check details
specify extension info spec-kit-review
```

### Working with Multiple Presets

```bash
# Install two presets with different priorities
specify preset add ./presets/security-focused --priority 5
specify preset add ./presets/performance-focused --priority 10

# List shows priority order (higher number takes precedence)
specify preset list

# Adjust priority if needed
specify preset priority security-focused 15
```

### Troubleshooting

```bash
# Temporarily disable a problematic extension
specify extension disable problematic-ext

# Debug the issue...

# Re-enable when fixed
specify extension enable problematic-ext
```

## Changes to Existing Code (for developers)

This feature modifies only two source files:

1. **`src/extension.ts`** (line 13): Added `registerCommands`, `unregisterCommands` to import. Made 6 methods async.
2. **`src/cli.ts`** (lines 117-127): Replaced TODO stubs with subcommand routing.

No new files. No structural changes. Upstream merges should be clean.
