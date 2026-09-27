/**
 * @oakoliver/specify-cli - Workflow Overlay Commands
 *
 * ``specify workflow overlay list|add|remove|enable|disable|set-priority``
 * (port of ``workflows/overlay/__init__.py`` + ``workflows/overlay/command_*.py``).
 *
 * @module workflows/overlay/commands
 */

import { defineCommand, dispatchGroup, type GroupSpec } from '../../cli-args.js';
import { CliExit } from '../../console.js';
import { requireSpecifyProject } from '../commands.js';
import {
  workflowOverlayAdd,
  workflowOverlayDisable,
  workflowOverlayEnable,
  workflowOverlayList,
  workflowOverlayRemove,
  workflowOverlaySetPriority,
} from './operations.js';

// ============================================================================
// Commands
// ============================================================================

const WF_ARG = { name: 'workflow_id', help: 'Workflow ID the overlay extends', required: true };
const OV_ARG = { name: 'overlay_id', help: 'Overlay ID', required: true };

/** The ``overlay`` Typer sub-app. */
export const OVERLAY_GROUP: GroupSpec = {
  name: 'overlay',
  help: 'Manage workflow overlays',
  commands: [
    defineCommand(
      {
        name: 'add',
        help: 'Add a project-local overlay for a workflow.',
        arguments: [{ name: 'source', help: 'Path to overlay YAML file', required: true, type: 'path' }],
        options: [
          {
            name: 'priority',
            flags: ['--priority'],
            type: 'int',
            default: 10,
            showDefault: true,
            help: 'Resolution priority (lower = higher precedence, default 10)',
          },
        ],
      },
      (parsed) => {
        const projectRoot = requireSpecifyProject();
        if (workflowOverlayAdd(projectRoot, String(parsed.args.source), parsed.options.priority as number) === null) {
          throw new CliExit(1);
        }
      },
    ),
    defineCommand(
      {
        name: 'set-priority',
        help: 'Set the priority of a project-local overlay.',
        arguments: [
          WF_ARG,
          OV_ARG,
          { name: 'priority', help: 'New priority (lower = higher precedence)', required: true, type: 'int' },
        ],
      },
      (parsed) => {
        const projectRoot = requireSpecifyProject();
        if (
          !workflowOverlaySetPriority(
            projectRoot,
            String(parsed.args.workflow_id),
            String(parsed.args.overlay_id),
            parsed.args.priority as number,
          )
        ) {
          throw new CliExit(1);
        }
      },
    ),
    defineCommand({ name: 'enable', help: 'Enable a project-local overlay.', arguments: [WF_ARG, OV_ARG] }, (parsed) => {
      const projectRoot = requireSpecifyProject();
      if (!workflowOverlayEnable(projectRoot, String(parsed.args.workflow_id), String(parsed.args.overlay_id))) {
        throw new CliExit(1);
      }
    }),
    defineCommand({ name: 'disable', help: 'Disable a project-local overlay.', arguments: [WF_ARG, OV_ARG] }, (parsed) => {
      const projectRoot = requireSpecifyProject();
      if (!workflowOverlayDisable(projectRoot, String(parsed.args.workflow_id), String(parsed.args.overlay_id))) {
        throw new CliExit(1);
      }
    }),
    defineCommand({ name: 'remove', help: 'Remove a project-local overlay.', arguments: [WF_ARG, OV_ARG] }, (parsed) => {
      const projectRoot = requireSpecifyProject();
      if (!workflowOverlayRemove(projectRoot, String(parsed.args.workflow_id), String(parsed.args.overlay_id))) {
        throw new CliExit(1);
      }
    }),
    defineCommand(
      {
        name: 'list',
        help: 'List overlays for a workflow.',
        arguments: [{ name: 'workflow_id', help: 'Workflow ID', required: true }],
      },
      (parsed) => {
        const projectRoot = requireSpecifyProject();
        if (workflowOverlayList(projectRoot, String(parsed.args.workflow_id)) === null) {
          throw new CliExit(1);
        }
      },
    ),
  ],
};

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Run ``specify workflow overlay <args>``; returns the exit code.
 *
 * @param args argv after ``workflow overlay``.
 */
export async function runWorkflowOverlayCommand(args: string[]): Promise<number> {
  return dispatchGroup(OVERLAY_GROUP, args, 'specify workflow overlay');
}
