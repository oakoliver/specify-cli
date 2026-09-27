# spec-kit Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-03-28

## Active Technologies
- JSON registry files at `.specify/extensions/.registry` and `.specify/presets/.registry` (009-cli-commands-implementation)
- TypeScript 5.0+ targeting ES2022 + None (zero runtime dependencies per constitution). `@oakoliver/huh` and `@oakoliver/lipgloss` are the only permitted runtime dependencies. (009-cli-commands-implementation)

- TypeScript 5.0+ targeting ES2022 + None (zero runtime dependencies per constitution) (009-cli-commands-implementation)

## Project Structure

```text
src/
tests/
```

## Commands

bun test && bunx tsc --noEmit

## Code Style

TypeScript 5.0+ targeting ES2022: Follow standard conventions

## Recent Changes
- v2.0.0 upstream sync: 1:1 parity with github/spec-kit v1.0.12. Bundled assets live in `core_pack/` (mirrors upstream wheel `specify_cli/core_pack`); source modules mirror `specify_cli/*` (e.g. `_download_security.py` -> `src/download-security.ts`, `presets/_manager.py` -> `src/presets/manager.ts`). Zero-dep YAML in `src/yaml.ts`, Rich-markup console in `src/console.ts`, Typer-like parser in `src/cli-args.ts`.
- 009-cli-commands-implementation: Added TypeScript 5.0+ targeting ES2022 + None (zero runtime dependencies per constitution). `@oakoliver/huh` and `@oakoliver/lipgloss` are the only permitted runtime dependencies.
- 009-cli-commands-implementation: Added TypeScript 5.0+ targeting ES2022 + None (zero runtime dependencies per constitution)
- 009-cli-commands-implementation: Added TypeScript 5.0+ targeting ES2022 + None (zero runtime dependencies per constitution)


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
