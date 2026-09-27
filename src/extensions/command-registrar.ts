/**
 * @oakoliver/specify-cli - Extension command registrar
 *
 * Port of the backward-compatible ``CommandRegistrar`` wrapper from
 * ``specify_cli/extensions/__init__.py``. Extension-specific methods accept
 * {@link ExtensionManifest} objects and delegate to the shared registrar in
 * ``src/agents.ts``.
 *
 * @module extensions/command-registrar
 */

import { CommandRegistrar as AgentRegistrar, type CommandInfo } from '../agents.js';
import { ExtensionError } from './errors.js';
import type { Dict, ExtensionManifest } from './manifest.js';

function contextNoteFor(extId: string): string {
  return `\n<!-- Extension: ${extId} -->\n<!-- Config: .specify/extensions/${extId}/ -->\n`;
}

/** Handles registration of extension commands with AI agents. */
export class CommandRegistrar {
  private readonly registrar: AgentRegistrar;

  constructor() {
    this.registrar = new AgentRegistrar();
  }

  /** Agent registration configs (re-exported from the shared registrar). */
  static get AGENT_CONFIGS(): Record<string, Dict> {
    return AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>;
  }

  get AGENT_CONFIGS(): Record<string, Dict> {
    return AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>;
  }

  static parseFrontmatter(content: string): [Dict, string] {
    return AgentRegistrar.parseFrontmatter(content) as [Dict, string];
  }

  static renderFrontmatter(fm: Dict): string {
    return AgentRegistrar.renderFrontmatter(fm);
  }

  static writeCopilotPrompt(projectRoot: string, cmdName: string): void {
    AgentRegistrar.writeCopilotPrompt(projectRoot, cmdName);
  }

  /** Preserve extension-specific comment format for backward compatibility. */
  renderMarkdownCommand(frontmatter: Dict, body: string, extId: string): string {
    return AgentRegistrar.renderFrontmatter(frontmatter) + '\n' + contextNoteFor(extId) + body;
  }

  /** Preserve extension-specific context comments for backward compatibility. */
  renderTomlCommand(frontmatter: Dict, body: string, extId: string): string {
    const base = this.registrar.renderTomlCommand(frontmatter, body, extId);
    const contextLines = `# Extension: ${extId}\n# Config: .specify/extensions/${extId}/\n`;
    return base.replace(/\n+$/, '') + '\n' + contextLines;
  }

  /** Register extension commands for a specific agent. */
  registerCommandsForAgent(
    agentName: string,
    manifest: ExtensionManifest,
    extensionDir: string,
    projectRoot: string,
    linkOutputs = false,
  ): string[] {
    if (!Object.prototype.hasOwnProperty.call(this.AGENT_CONFIGS, agentName)) {
      throw new ExtensionError(`Unsupported agent: ${agentName}`);
    }
    return this.registrar.registerCommands(
      agentName,
      manifest.commands as CommandInfo[],
      manifest.id,
      extensionDir,
      projectRoot,
      {
        contextNote: contextNoteFor(manifest.id),
        linkOutputs,
        extensionId: manifest.id,
        author: manifest.data.extension?.author ?? null,
      },
    );
  }

  /** Register extension commands for all detected agents. */
  registerCommandsForAllAgents(
    manifest: ExtensionManifest,
    extensionDir: string,
    projectRoot: string,
    opts: { linkOutputs?: boolean; createMissingActiveSkillsDir?: boolean; onlyAgent?: string | null } = {},
  ): Record<string, string[]> {
    return this.registrar.registerCommandsForAllAgents(
      manifest.commands as CommandInfo[],
      manifest.id,
      extensionDir,
      projectRoot,
      {
        contextNote: contextNoteFor(manifest.id),
        linkOutputs: opts.linkOutputs ?? false,
        createMissingActiveSkillsDir: opts.createMissingActiveSkillsDir ?? false,
        onlyAgent: opts.onlyAgent ?? null,
        extensionId: manifest.id,
        author: manifest.data.extension?.author ?? null,
      },
    );
  }

  /** Remove previously registered command files from agent directories. */
  unregisterCommands(registeredCommands: Record<string, string[]>, projectRoot: string): void {
    this.registrar.unregisterCommands(registeredCommands, projectRoot);
  }

  /** Register extension commands for Claude Code agent. */
  registerCommandsForClaude(
    manifest: ExtensionManifest,
    extensionDir: string,
    projectRoot: string,
    linkOutputs = false,
  ): string[] {
    return this.registerCommandsForAgent('claude', manifest, extensionDir, projectRoot, linkOutputs);
  }
}
