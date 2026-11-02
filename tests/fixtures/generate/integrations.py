"""Regenerate the integration golden fixtures from upstream Python spec-kit.

Usage (with an environment where upstream ``specify-cli`` is installed, e.g.
``uv pip install git+https://github.com/github/spec-kit@v1.2.5``)::

    python tests/fixtures/generate/integrations.py [out_dir]

Writes, into ``tests/fixtures/integrations/`` (or *out_dir*):

- ``setup-<key>[__<variant>].json``  ``IntegrationBase.setup()`` output
- ``dispatch.json``                  ``build_exec_args`` / invocation metadata
- ``registrar-extension-commands.json`` / ``registrar-preset-commands.json``
                                     ``CommandRegistrar.register_commands``
- ``units.json``                     unit-level renderer outputs

The inputs below are the ones the TypeScript tests replay
(tests/integrations-rendering.test.ts, tests/integrations-dispatch.test.ts,
tests/agents.test.ts); keep them in sync.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "integrations"

from specify_cli.agents import CommandRegistrar  # noqa: E402
from specify_cli.integrations import INTEGRATION_REGISTRY, get_integration  # noqa: E402
from specify_cli.integrations.base import (  # noqa: E402
    IntegrationBase,
    SkillsIntegration,
    TomlIntegration,
    YamlIntegration,
    yaml_quote,
)
from specify_cli.integrations.claude import ClaudeIntegration  # noqa: E402
from specify_cli.integrations.manifest import IntegrationManifest  # noqa: E402

try:
    from importlib.metadata import version as _dist_version

    SPEC_KIT_VERSION = _dist_version("specify-cli")
except Exception:  # pragma: no cover
    SPEC_KIT_VERSION = "unknown"


def dump(name: str, data: object) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def list_files(root: Path, skip=lambda rel: False) -> list[str]:
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            p = Path(dirpath) / f
            if p.is_symlink() or not p.is_file():
                continue
            rel = p.relative_to(root).as_posix()
            if not skip(rel):
                out.append(rel)
    return sorted(out, key=lambda r: Path(r).parts)


class _Home:
    """Point HOME at a fresh temp dir for the duration of a block."""

    def __enter__(self):
        self.saved = os.environ.get("HOME")
        self.home = Path(tempfile.mkdtemp(prefix="speckit-home-")).resolve()
        os.environ["HOME"] = str(self.home)
        return self.home

    def __exit__(self, *exc):
        if self.saved is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.saved
        shutil.rmtree(self.home, ignore_errors=True)


# ---------------------------------------------------------------------------
# setup()
# ---------------------------------------------------------------------------

SETUP_CASES: list[tuple[str, str | None, dict | None]] = [
    ("agy", None, None),
    ("alquimia", None, None),
    ("amp", None, None),
    ("bob", None, None),
    ("bob", "legacy_commands", {"legacy_commands": True}),
    ("claude", None, None),
    ("claude", "no_model_invocation", {"no_model_invocation": True}),
    ("cline", None, None),
    ("codex", None, None),
    ("command-code", None, None),
    ("copilot", None, None),
    ("copilot", "commands", {"commands": True}),
    ("cursor-agent", None, None),
    ("devin", None, None),
    ("droid", None, None),
    ("firebender", None, None),
    ("forge", None, None),
    ("gemini", None, None),
    ("generic", "flat", {"commands_dir": ".myagent/commands"}),
    ("generic", "skills", {"commands_dir": ".myagent/skills", "skills": True}),
    ("goose", None, None),
    ("junie", None, None),
    ("kimi", None, None),
    ("kiro-cli", None, None),
    ("mcode", None, None),
    ("none", None, None),
    ("opencode", None, None),
    ("qwen", None, None),
    ("rovodev", None, None),
    ("tabnine", None, None),
    ("vibe", None, None),
    ("vibe", "no_model_invocation", {"no_model_invocation": True}),
    ("zcode", None, None),
]


def gen_setup() -> None:
    for key, variant, opts in SETUP_CASES:
        integ = get_integration(key)
        if integ is None:
            print(f"skip setup {key}: not registered", file=sys.stderr)
            continue
        if variant == "no_model_invocation" and not any(
            o.name == "--no-model-invocation" for o in integ.options()
        ):
            print(f"skip setup {key}__{variant}: option missing", file=sys.stderr)
            continue
        with _Home():
            tmp = Path(tempfile.mkdtemp(prefix="speckit-render-")).resolve()
            try:
                manifest = IntegrationManifest(key, tmp, SPEC_KIT_VERSION)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    created = integ.setup(tmp, manifest, opts, script_type="sh", events={})
                files = {rel: (tmp / rel).read_text(encoding="utf-8") for rel in list_files(tmp)}
                created_rel = []
                for p in created:
                    try:
                        created_rel.append(Path(p).resolve().relative_to(tmp).as_posix())
                    except ValueError:
                        pass
                name = f"setup-{key}{'__' + variant if variant else ''}.json"
                dump(
                    name,
                    {
                        "key": key,
                        "parsed_options": opts,
                        "files": files,
                        "created": sorted(created_rel),
                        "manifest_files": sorted(manifest.files),
                    },
                )
            finally:
                shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

PROMPTS = ["/speckit.plan build it", "/speckit-plan", "free text", "/help", "/speckit."]
MODELS = [None, "m1"]
INVOCATIONS = ["speckit.plan|", "specify|my feature", "speckit.git.commit|-m x"]


def _env_overrides(key: str) -> dict[str, str]:
    k = key.upper().replace("-", "_")
    return {
        f"SPECKIT_INTEGRATION_{k}_EXTRA_ARGS": '--x "a b"',
        f"SPECKIT_INTEGRATION_{k}_EXECUTABLE": "/opt/bin/tool",
    }


def _clear_speckit_env() -> None:
    for k in list(os.environ):
        if k.startswith("SPECKIT_"):
            del os.environ[k]


def gen_dispatch() -> None:
    out: dict[str, dict] = {}
    saved_path = os.environ.get("PATH", "")
    os.environ["PATH"] = "/usr/bin:/bin"
    try:
        for key, registered in INTEGRATION_REGISTRY.items():
            # Fresh instance: setup() mutates per-instance state (e.g. copilot's
            # skills mode), and the registry instances are shared.
            integ = type(registered)()
            execs = []
            for prompt in PROMPTS:
                for model in MODELS:
                    for output_json in (True, False):
                        for env in ({}, _env_overrides(key)):
                            _clear_speckit_env()
                            os.environ.update(env)
                            try:
                                with warnings.catch_warnings():
                                    warnings.simplefilter("ignore")
                                    actual = integ.build_exec_args(
                                        prompt,
                                        model=model,
                                        output_json=output_json,
                                        integration_args=["./agent.yaml"] if key == "docker-agent" else None,
                                        integration_options=(
                                            {"agent": "root", "safety": "strict"} if key == "docker-agent" else None
                                        ),
                                        project_root=None,
                                    )
                            except Exception as exc:  # noqa: BLE001
                                actual = {"error": type(exc).__name__, "message": str(exc)}
                            execs.append([prompt, model, output_json, env, actual])
            _clear_speckit_env()
            reg = dict(integ.registrar_config or {})
            reg.pop("format_name", None)
            invocations = {}
            for spec in INVOCATIONS:
                name, args = spec.split("|")
                invocations[spec] = integ.build_command_invocation(name, args)
            out[key] = {
                "invocations": invocations,
                "exec": execs,
                "options": [[o.name, o.is_flag, o.required, o.default, o.help] for o in integ.options()],
                "config": integ.config,
                "registrar_config": reg,
                "invoke_separator": integ.invoke_separator,
                "multi_install_safe": integ.multi_install_safe,
                "effective_sep_default": integ.effective_invoke_separator(None),
                "effective_sep_skills": integ.effective_invoke_separator({"skills": True}),
                "sep_for_mode": [integ.invoke_separator_for_mode(True), integ.invoke_separator_for_mode(False)],
                "is_skills_mode_default": integ.is_skills_mode(None),
                "is_skills_mode_skills": integ.is_skills_mode({"skills": True}),
                "supports_events": integ.supports_events(),
                "command_filename": integ.command_filename("plan"),
            }
    finally:
        os.environ["PATH"] = saved_path
    dump("dispatch.json", out)


# ---------------------------------------------------------------------------
# CommandRegistrar.register_commands
# ---------------------------------------------------------------------------

EXT_CMD = """---
description: "Commit changes with a conventional message \u2014 \u00fcber fast. This description is deliberately long so that YAML emitters would fold it across multiple lines if width were limited"
argument-hint: "Optional commit message"
handoffs:
  - label: Plan it
    agent: speckit.plan
    prompt: Continue with speckit.git.commit
scripts:
  sh: scripts/bash/commit.sh --json {ARGS}
  ps: scripts/powershell/commit.ps1 -Json {ARGS}
---

# Commit

User input: $ARGUMENTS

Run `{SCRIPT}` from the repo root, then read `agents/helper.md` and templates/commit-template.md.
Call __SPECKIT_COMMAND_GIT_COMMIT__ or __SPECKIT_COMMAND_PLAN__ when done (see ../../scripts/bash/common.sh).
Agent: __AGENT__

## Hooks

- For each executable hook, output the following
  - `/speckit.git.commit`
Windows path: C:\\Users\\dev\\file
"""

SIMPLE = """---
description: Show status
---
Status for $ARGUMENTS
"""


def _read_tree(root: Path, home: Path, skip) -> dict[str, str]:
    actual = {rel: (root / rel).read_text(encoding="utf-8") for rel in list_files(root, skip)}
    for rel in list_files(home):
        actual[f"~/{rel}"] = (home / rel).read_text(encoding="utf-8")
    return actual


def gen_registrar() -> None:
    agents = list(CommandRegistrar.AGENT_CONFIGS)
    ext_out: dict[str, dict] = {}
    preset_out: dict[str, dict] = {}
    for agent in agents:
        with _Home() as home:
            tmp = Path(tempfile.mkdtemp(prefix="speckit-reg-")).resolve()
            try:
                (tmp / ".specify").mkdir(parents=True)
                (tmp / ".specify" / "init-options.json").write_text(
                    json.dumps({"ai": agent, "script": "sh"}), encoding="utf-8"
                )
                ext = tmp / ".specify" / "extensions" / "git"
                for rel, content in {
                    "commands/commit.md": EXT_CMD,
                    "commands/status.md": SIMPLE,
                    "agents/.keep": "",
                }.items():
                    (ext / rel).parent.mkdir(parents=True, exist_ok=True)
                    (ext / rel).write_text(content, encoding="utf-8")
                registered = CommandRegistrar().register_commands(
                    agent,
                    [
                        {"name": "speckit.git.commit", "file": "commands/commit.md", "aliases": ["speckit.git.ci"]},
                        {"name": "speckit.git.status", "file": "commands/status.md"},
                    ],
                    "git",
                    ext,
                    tmp,
                    extension_id="git",
                )
                files = _read_tree(
                    tmp,
                    home,
                    lambda r: r.startswith(".specify/extensions") or r.endswith("init-options.json"),
                )
                ext_out[agent] = {"registered": registered, "files": files}
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        with _Home() as home:
            tmp = Path(tempfile.mkdtemp(prefix="speckit-reg-")).resolve()
            try:
                src = tmp / "src"
                src.mkdir()
                (src / "x.md").write_text(EXT_CMD, encoding="utf-8")
                registered = CommandRegistrar().register_commands(
                    agent,
                    [{"name": "speckit.plan", "file": "x.md"}],
                    "my-preset",
                    src,
                    tmp,
                    context_note="\n<!-- Preset: my-preset -->\n",
                )
                files = _read_tree(tmp, home, lambda r: r == "src" or r.startswith("src/"))
                preset_out[agent] = {"registered": registered, "files": files}
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    dump("registrar-extension-commands.json", ext_out)
    dump("registrar-preset-commands.json", preset_out)


# ---------------------------------------------------------------------------
# units.json — inputs are replayed from the existing file
# ---------------------------------------------------------------------------


def gen_units() -> None:
    path = OUT / "units.json"
    units = json.loads(path.read_text(encoding="utf-8"))
    reg = CommandRegistrar()
    fns = {
        "yaml_quote": lambda a: yaml_quote(a[0]),
        "toml_string": lambda a: TomlIntegration._render_toml_string(a[0]),
        "render_toml": lambda a: TomlIntegration._render_toml(a[0], a[1]),
        "registrar_toml": lambda a: reg.render_toml_command(a[0], a[1], "src"),
        "render_yaml": lambda a: YamlIntegration._render_yaml(a[0], a[1], a[2], "templates/commands/x.md"),
        "human_title": lambda a: YamlIntegration._human_title(a[0]),
        "rewrite_paths": lambda a: CommandRegistrar.rewrite_project_relative_paths(a[0], a[1]),
        "command_refs": lambda a: IntegrationBase.resolve_command_refs(a[0], a[1], a[2]),
        "argument_hint": lambda a: ClaudeIntegration.inject_argument_hint(a[0], a[1]),
        "frontmatter_flag": lambda a: ClaudeIntegration._inject_frontmatter_flag(a[0], "user-invocable"),
        "hook_note": lambda a: SkillsIntegration._inject_hook_command_note(a[0], a[1]),
        "parse_frontmatter": lambda a: list(CommandRegistrar.parse_frontmatter(a[0])),
        "render_frontmatter": lambda a: CommandRegistrar.render_frontmatter(a[0]),
        "process_template": lambda a: IntegrationBase.process_template(a[0], a[1], a[2], a[3], a[4]),
    }
    out = {}
    for name, cases in units.items():
        fn = fns[name]
        out[name] = [list(c[:-1]) + [fn(c[:-1])] for c in cases]
    dump("units.json", out)


if __name__ == "__main__":
    which = set(os.environ.get("GEN_ONLY", "setup,dispatch,registrar,units").split(","))
    if "units" in which:
        gen_units()
    if "setup" in which:
        gen_setup()
    if "dispatch" in which:
        gen_dispatch()
    if "registrar" in which:
        gen_registrar()
    print(f"fixtures written to {OUT} (spec-kit {SPEC_KIT_VERSION})")
