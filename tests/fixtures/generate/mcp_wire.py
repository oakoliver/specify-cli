"""Record upstream `specify mcp` JSON-RPC responses for the wire-parity test.

Usage:
  python3 tests/fixtures/generate/mcp_wire.py /path/to/upstream/bin/specify > tests/fixtures/mcp/wire.json

Creates a scratch project with the given (upstream) `specify init --integration
claude --script sh`, starts `specify mcp` inside it, replays SCENARIOS and
prints the responses with the project path replaced by <PROJECT>.
"""
import json
import os
import subprocess
import sys
import tempfile

SPECIFY = sys.argv[1]

INIT = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "parity", "version": "1"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def call(name, arguments=None):
    params = {"name": name}
    if arguments is not None:
        params["arguments"] = arguments
    return {"method": "tools/call", "params": params}


# (label, message-without-jsonrpc/id) ; "raw" entries are sent verbatim.
SCENARIOS = [
    ("init-2025-06-18", INIT | {}),
    ("init-2024-11-05", {"method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "p", "version": "1"}}}),
    ("init-unknown-version", {"method": "initialize", "params": {"protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "p", "version": "1"}}}),
    ("ping", {"method": "ping"}),
    ("tools-list", {"method": "tools/list"}),
    ("unknown-method", {"method": "resources/unknown"}),
    ("list-commands", call("specify_list_commands", {})),
    ("list-commands-extra", call("specify_list_commands", {"x": 1})),
    ("describe-version", call("specify_describe_command", {"command": "version"})),
    ("describe-unknown", call("specify_describe_command", {"command": "init"})),
    ("describe-missing-arg", call("specify_describe_command", {})),
    ("run-unknown", call("specify_run_command", {"command": "init"})),
    ("version-extra", call("specify_version", {"x": 1})),
    ("unknown-tool", call("specify_nope", {})),
    ("artifact-list-page", call("specify_artifact_list", {"limit": 2})),
    ("artifact-list-cursor", call("specify_artifact_list", {"limit": 2, "cursor": "2"})),
    ("artifact-list-last", call("specify_artifact_list", {"limit": 1000, "cursor": "30"})),
    ("artifact-list-bad-limit", call("specify_artifact_list", {"limit": 0})),
    ("artifact-list-bad-limit-type", call("specify_artifact_list", {"limit": "5"})),
    ("artifact-list-bad-cursor", call("specify_artifact_list", {"cursor": "01"})),
    ("artifact-list-relative", call("specify_artifact_list", {"project_directory": "relative/dir"})),
    ("artifact-list-not-project", call("specify_artifact_list", {"project_directory": "/"})),
    ("artifact-list-extra", call("specify_artifact_list", {"bogus": True})),
    ("artifact-info-plan", call("specify_artifact_info", {"identifier": "command:plan"})),
    ("artifact-info-template", call("specify_artifact_info", {"identifier": "spec-template", "kind": "template"})),
    ("artifact-info-unknown", call("specify_artifact_info", {"identifier": "command:nope"})),
    ("artifact-info-bad-id", call("specify_artifact_info", {"identifier": "weird:thing"})),
    ("artifact-info-hook-unknown", call("specify_artifact_info", {"identifier": "hook:before_plan/speckit.x"})),
    ("artifact-info-bad-kind", call("specify_artifact_info", {"identifier": "plan", "kind": "bogus"})),
    ("artifact-info-missing", call("specify_artifact_info", {})),
    ("artifact-info-relative", call("specify_artifact_info", {"identifier": "plan", "project_directory": "x"})),
    ("workflow-list", call("specify_workflow_list", {})),
    ("workflow-list-limit", call("specify_workflow_list", {"limit": 1})),
    ("workflow-list-bad-limit", call("specify_workflow_list", {"limit": 1001})),
    ("workflow-list-not-project", call("specify_workflow_list", {"project_directory": "/"})),
    ("workflow-list-relative", call("specify_workflow_list", {"project_directory": "rel"})),
]


def main():
    work = os.path.realpath(tempfile.mkdtemp(prefix="speckit-mcp-wire-"))
    project = os.path.join(work, "proj")
    subprocess.run([SPECIFY, "init", "proj", "--integration", "claude", "--script", "sh",
                    "--ignore-agent-tools", "--non-interactive"], cwd=work, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=os.environ | {"NO_COLOR": "1"})
    proc = subprocess.Popen([SPECIFY, "mcp"], cwd=project, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    out = []

    def send(msg):
        proc.stdin.write((json.dumps(msg) + "\n").encode())
        proc.stdin.flush()

    def recv():
        return json.loads(proc.stdout.readline())

    send(INIT)
    recv()
    send(INITIALIZED)
    for index, (label, body) in enumerate(SCENARIOS, start=1):
        msg = {"jsonrpc": "2.0", "id": index} | {k: v for k, v in body.items() if k not in ("jsonrpc", "id")}
        send(msg)
        out.append({"label": label, "request": msg, "response": recv()})
    proc.stdin.close()
    proc.wait(timeout=30)
    text = json.dumps(out, indent=1, ensure_ascii=False).replace(project, "<PROJECT>")
    print(text)


main()
