/**
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

export const WORKFLOW_TOOLS: readonly ToolInventory[] = [
  {
    "operationId": "workflow.add",
    "cliPath": "specify workflow add",
    "mcpToolName": "specify_workflow_add",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Source selection, custom-step loading, trust prompts and transactional installation remain CLI-owned; no shared typed add operation or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.disable",
    "cliPath": "specify workflow disable",
    "mcpToolName": "specify_workflow_disable",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "The registry mutation uses _commands._set_workflow_enabled with CLI errors/output; no shared typed disable operation or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.enable",
    "cliPath": "specify workflow enable",
    "mcpToolName": "specify_workflow_enable",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "The registry mutation uses _commands._set_workflow_enabled with CLI errors/output; no shared typed enable operation or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.info",
    "cliPath": "specify workflow info",
    "mcpToolName": "specify_workflow_info",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Installed-definition/catalog selection and result rendering remain in command_info; no shared typed info operation or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.list",
    "cliPath": "specify workflow list",
    "mcpToolName": "specify_workflow_list",
    "contractVersion": "1",
    "disposition": "available",
    "dispositionReason": null,
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.remove",
    "cliPath": "specify workflow remove",
    "mcpToolName": "specify_workflow_remove",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Staged directory removal and attempted directory recovery after registry failure remain in command_remove; no shared typed remove operation or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.resolve",
    "cliPath": "specify workflow resolve",
    "mcpToolName": "specify_workflow_resolve",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "overlay.operations.workflow_resolve renders CLI diagnostics and returns a dictionary or None; no shared typed resolve outcome or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.resume",
    "cliPath": "specify workflow resume",
    "mcpToolName": "specify_workflow_resume",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Owner-root resolution, integration loading and CLI input/error mapping surround WorkflowEngine.resume; no shared typed resume contract or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.run",
    "cliPath": "specify workflow run",
    "mcpToolName": "specify_workflow_run",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Integration/custom-step loading, inputs and CLI error handling surround WorkflowEngine.execute; no shared typed run contract or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.search",
    "cliPath": "specify workflow search",
    "mcpToolName": "specify_workflow_search",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "WorkflowCatalog.search supplies catalog data but command_search owns mapping/rendering; no shared typed search outcome or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.status",
    "cliPath": "specify workflow status",
    "mcpToolName": "specify_workflow_status",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "RunState.load/list_runs results and JSON/error mapping are assembled in command_status; no shared typed status operation or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.update",
    "cliPath": "specify workflow update",
    "mcpToolName": "specify_workflow_update",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Custom-step loading, version selection, confirmation and installation remain CLI-owned; no shared typed update operation or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.catalog.add",
    "cliPath": "specify workflow catalog add",
    "mcpToolName": "specify_workflow_catalog_add",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "WorkflowCatalog.add_catalog mutates configuration, but its command-level request/error/outcome contract and MCP adapter are not defined.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.catalog.list",
    "cliPath": "specify workflow catalog list",
    "mcpToolName": "specify_workflow_catalog_list",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "WorkflowCatalog.get_catalog_configs returns dictionaries rendered by the CLI; no shared typed catalog-list outcome or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.catalog.remove",
    "cliPath": "specify workflow catalog remove",
    "mcpToolName": "specify_workflow_catalog_remove",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "WorkflowCatalog.remove_catalog owns configuration edits, but the CLI maps arguments/errors; no shared typed removal contract or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.add",
    "cliPath": "specify workflow overlay add",
    "mcpToolName": "specify_workflow_overlay_add",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_add stages overlay files but prints CLI diagnostics and returns Path or None; no shared typed add contract or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.disable",
    "cliPath": "specify workflow overlay disable",
    "mcpToolName": "specify_workflow_overlay_disable",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_disable uses CLI-bound overlay mutation/error helpers; no shared typed disable outcome or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.enable",
    "cliPath": "specify workflow overlay enable",
    "mcpToolName": "specify_workflow_overlay_enable",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_enable uses CLI-bound overlay mutation/error helpers; no shared typed enable outcome or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.list",
    "cliPath": "specify workflow overlay list",
    "mcpToolName": "specify_workflow_overlay_list",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_list prints CLI diagnostics and returns dictionaries or None; no shared typed list outcome or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.remove",
    "cliPath": "specify workflow overlay remove",
    "mcpToolName": "specify_workflow_overlay_remove",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_remove deletes local files with CLI-bound error reporting; no shared typed remove outcome or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.overlay.set-priority",
    "cliPath": "specify workflow overlay set-priority",
    "mcpToolName": "specify_workflow_overlay_set_priority",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "workflow_overlay_set_priority uses CLI-bound YAML mutation/error helpers; no shared typed priority-change outcome or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.step.add",
    "cliPath": "specify workflow step add",
    "mcpToolName": "specify_workflow_step_add",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Package validation/install helpers exist, but source/trust selection and command-level outcomes remain CLI-owned; no typed add contract or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.step.info",
    "cliPath": "specify workflow step info",
    "mcpToolName": "specify_workflow_step_info",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Builtin/installed/catalog selection and result rendering remain in command_info; no shared typed step-info outcome or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.step.list",
    "cliPath": "specify workflow step list",
    "mcpToolName": "specify_workflow_step_list",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "The CLI combines STEP_REGISTRY and StepRegistry dictionaries for display; no shared typed step-list outcome or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.step.remove",
    "cliPath": "specify workflow step remove",
    "mcpToolName": "specify_workflow_step_remove",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "Registry removal, direct package deletion and attempted registry restoration on deletion failure remain in command_remove; no shared typed step-remove operation or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.step.search",
    "cliPath": "specify workflow step search",
    "mcpToolName": "specify_workflow_step_search",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "StepCatalog.search supplies catalog data but the CLI maps/renders it; no shared typed step-search outcome or MCP adapter.",
    "capabilities": [
      "execution",
      "local-read",
      "project-write"
    ],
    "networkAccess": "optional"
  },
  {
    "operationId": "workflow.step.catalog.add",
    "cliPath": "specify workflow step catalog add",
    "mcpToolName": "specify_workflow_step_catalog_add",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "StepCatalog.add_catalog mutates configuration, but its command-level request/error/outcome contract and MCP adapter are not defined.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.step.catalog.list",
    "cliPath": "specify workflow step catalog list",
    "mcpToolName": "specify_workflow_step_catalog_list",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "StepCatalog.get_catalog_configs returns dictionaries rendered by the CLI; no shared typed step-catalog-list outcome or MCP adapter.",
    "capabilities": [
      "local-read"
    ],
    "networkAccess": "none"
  },
  {
    "operationId": "workflow.step.catalog.remove",
    "cliPath": "specify workflow step catalog remove",
    "mcpToolName": "specify_workflow_step_catalog_remove",
    "contractVersion": null,
    "disposition": "unavailable",
    "dispositionReason": "StepCatalog.remove_catalog edits configuration, but the CLI maps arguments/errors; no shared typed removal contract or MCP adapter.",
    "capabilities": [
      "local-read",
      "project-write"
    ],
    "networkAccess": "none"
  }
];
