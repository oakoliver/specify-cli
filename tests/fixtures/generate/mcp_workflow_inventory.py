"""Generate src/mcp-server/workflow-inventory.ts from upstream's WORKFLOW_TOOLS.

Usage (with upstream spec-kit importable, e.g. its venv python):
  python tests/fixtures/generate/mcp_workflow_inventory.py > src/mcp-server/workflow-inventory.ts
"""
import json

from specify_cli.workflows._mcp import WORKFLOW_TOOLS

rows = [
    {
        "operationId": t.operation_id,
        "cliPath": t.cli_path,
        "mcpToolName": t.mcp_tool_name,
        "contractVersion": t.contract_version,
        "disposition": t.disposition,
        "dispositionReason": t.disposition_reason,
        "capabilities": sorted(t.capabilities),
        "networkAccess": t.network_access,
    }
    for t in WORKFLOW_TOOLS
]
print('''/**
 * @oakoliver/specify-cli - Workflow MCP inventory
 *
 * Explicit MCP dispositions for the complete `specify workflow` hierarchy
 * (port of spec-kit v1.2.5 `workflows/_mcp.py`, #5054). Only workflow.list
 * has a shared operation and adapter; unavailable records keep their
 * prospective tool names for parity checks only.
 *
 * @module mcp-server/workflow-inventory
 */

import type { ToolInventory } from './tools.js';

export const WORKFLOW_TOOLS: readonly ToolInventory[] = ''' + json.dumps(rows, indent=2, ensure_ascii=False) + ';')
