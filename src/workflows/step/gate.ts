/**
 * @oakoliver/specify-cli - Gate Step
 *
 * Port of ``specify_cli/workflows/step/gate/__init__.py``: human review gate.
 *
 * @module workflows/step/gate
 */

import { readFileSync } from 'node:fs';

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  pyRepr,
  pyStr,
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';
import { readLine as consoleReadLine } from '../../console.js';

/**
 * Control characters except tab: C0 (incl. LF), DEL, and C1 (incl. ``\x9b``
 * CSI). Stripped from anything derived from a ``show_file`` before it is
 * printed so neither the contents nor the path can inject terminal escapes.
 */
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Print *promptText* (no newline) and read one line from stdin (``null`` on EOF). */
async function readLine(promptText: string): Promise<string | null> {
  process.stdout.write(promptText);
  return consoleReadLine();
}

/** Python ``str.isdecimal()`` for ASCII input. */
function isDecimal(s: string): boolean {
  return /^\p{Nd}+$/u.test(s);
}

/**
 * Interactive review gate.
 *
 * When running in an interactive terminal, prompts the user to choose an
 * option (e.g. approve / reject). Falls back to ``PAUSED`` when stdin is not a
 * TTY (CI, piped input) so the run can be resumed later with
 * ``specify workflow resume``.
 */
export class GateStep extends StepBase {
  static override typeKey = 'gate';

  /** Maximum number of ``show_file`` lines rendered at the prompt. */
  static MAX_SHOW_FILE_LINES = 200;

  /** ``sys.stdin.isatty()`` seam (replaceable in tests). */
  static stdinIsTTY = (): boolean => Boolean(process.stdin.isTTY);

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    const id = stepIdRepr(config);
    let message = dget(config, 'message', 'Review required.');
    if (typeof message === 'string' && message.includes('{{')) {
      message = evaluateExpression(message, context);
    }

    const options = dget(config, 'options', ['approve', 'reject']);
    const onReject = dget(config, 'on_reject', 'abort');
    const hasVerdictInput = dhas(config, 'verdict_input');
    const verdictInput = dget(config, 'verdict_input', null);

    if (
      !Array.isArray(options) ||
      !options.length ||
      !options.every((o) => typeof o === 'string')
    ) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${id}: 'options' must be a non-empty list of strings, got ${pyTypeName(options)}.`,
        output: { message, options, on_reject: onReject, choice: null },
      });
    }
    const opts = options as string[];

    if (onReject !== 'abort' && onReject !== 'skip' && onReject !== 'retry') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${id}: 'on_reject' must be 'abort', 'skip', or 'retry', got ${pyRepr(onReject)}.`,
        output: { message, options, on_reject: onReject, choice: null },
      });
    }

    if (hasVerdictInput && (typeof verdictInput !== 'string' || !verdictInput)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${id}: 'verdict_input' must be a non-empty string.`,
      });
    }

    if (hasVerdictInput && context.insideFanOut) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${id}: 'verdict_input' is not supported inside fan-out templates.`,
      });
    }

    let showFile = dget(config, 'show_file', null);
    if (typeof showFile === 'string' && showFile.includes('{{')) {
      showFile = evaluateExpression(showFile, context);
    }
    if (showFile !== null && showFile !== undefined) showFile = pyStr(showFile);
    else showFile = null;

    const output: Dict = {
      message,
      options,
      on_reject: onReject,
      show_file: showFile,
      choice: null,
    };

    let choice: string | null = null;
    let boundVerdictInput: string | null = null;
    if (verdictInput !== null && verdictInput !== undefined) {
      const vKey = verdictInput as string;
      const value = Object.prototype.hasOwnProperty.call(context.inputs, vKey)
        ? context.inputs[vKey]
        : null;
      if (value !== null && value !== undefined && value !== '') {
        if (typeof value !== 'string') {
          return new StepResult({
            status: StepStatus.FAILED,
            output,
            error:
              `Gate step ${id}: verdict input ` +
              `${pyRepr(vKey)} must be a string, got ${pyTypeName(value)}.`,
          });
        }
        choice = opts.find((option) => option.toLowerCase() === value.toLowerCase()) ?? null;
        if (choice === null) {
          return new StepResult({
            status: StepStatus.FAILED,
            output,
            error:
              `Gate step ${id}: verdict input ` +
              `${pyRepr(vKey)} value ${pyRepr(value)} does not match any ` +
              'configured option.',
          });
        }
        boundVerdictInput = vKey;
      }
    }

    if (choice === null) {
      if (!GateStep.stdinIsTTY()) {
        return new StepResult({ status: StepStatus.PAUSED, output });
      }
      choice = await GateStep.prompt(GateStep.composePrompt(message, showFile as string | null), opts);
    }
    output.choice = choice;

    const lower = choice.toLowerCase();
    if (lower === 'reject' || lower === 'abort') {
      if (onReject === 'abort') {
        output.aborted = true;
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: `Gate rejected by user at step ${id}`,
        });
      }
      if (onReject === 'retry') {
        if (boundVerdictInput !== null) context.inputs[boundVerdictInput] = '';
        return new StepResult({ status: StepStatus.PAUSED, output });
      }
      return new StepResult({ status: StepStatus.COMPLETED, output });
    }

    return new StepResult({ status: StepStatus.COMPLETED, output });
  }

  /** Build the gate's display text (message + optional ``show_file`` body). */
  static composePrompt(message: unknown, showFile: string | null): string {
    const text = pyStr(message);
    if (!showFile) return text;
    const header = `${stripControl(showFile)}:`;
    const body = [header, ...GateStep.readShowFile(showFile).map((line) => `  ${line}`)].join('\n');
    return `${text}\n\n${body}`;
  }

  /**
   * Display the gate message and prompt for a choice. Replaceable seam (tests
   * monkeypatch it, as upstream tests patch ``GateStep._prompt``).
   */
  static prompt = async (message: string, options: string[]): Promise<string> => {
    const out = (s: string): void => {
      process.stdout.write(s + '\n');
    };
    out('\n  ┌─ Gate ─────────────────────────────────────');
    for (const line of message.split('\n')) out(line ? `  │ ${line}` : '  │');
    out('  │');
    options.forEach((opt, i) => out(`  │  [${i + 1}] ${opt}`));
    out('  └────────────────────────────────────────────');

    for (;;) {
      const line = await readLine(`  Choose [1-${options.length}]: `);
      if (line === null) {
        out('');
        return options[options.length - 1] as string;
      }
      const raw = line.trim();
      if (isDecimal(raw)) {
        const n = parseInt(raw, 10);
        if (n >= 1 && n <= options.length) return options[n - 1] as string;
      }
      const match = options.find((o) => o.toLowerCase() === raw.toLowerCase());
      if (match !== undefined) return match;
      out(`  Invalid choice. Enter 1-${options.length} or an option name.`);
    }
  };

  /** Return the lines of ``showFile`` for display (bounded, sanitized). */
  static readShowFile(showFile: string): string[] {
    const lines: string[] = [];
    let truncated = false;
    let content: string;
    try {
      if (showFile.includes('\0')) throw new Error('embedded null byte');
      const buf = readFileSync(showFile);
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (exc) {
      return [stripControl(`(could not read file: ${GateStep.describeReadError(exc, showFile)})`)];
    }
    if (content.length) {
      const parts = content.split(/(?<=\n)/);
      for (const part of parts) {
        if (lines.length >= GateStep.MAX_SHOW_FILE_LINES) {
          truncated = true;
          break;
        }
        lines.push(stripControl(part.replace(/\n$/, '')));
      }
    }
    if (!lines.length && !truncated) return ['(file is empty)'];
    if (truncated) lines.push(`… (output truncated at ${GateStep.MAX_SHOW_FILE_LINES} lines)`);
    return lines;
  }

  private static describeReadError(exc: unknown, path: string): string {
    const e = exc as NodeJS.ErrnoException;
    const errnoText: Record<string, string> = {
      ENOENT: '[Errno 2] No such file or directory',
      EACCES: '[Errno 13] Permission denied',
      EISDIR: '[Errno 21] Is a directory',
      ENOTDIR: '[Errno 20] Not a directory',
    };
    if (e && typeof e.code === 'string' && errnoText[e.code]) {
      return `${errnoText[e.code]}: ${pyRepr(path)}`;
    }
    if (exc instanceof TypeError) return `'utf-8' codec can't decode file ${pyRepr(path)}`;
    return exc instanceof Error ? exc.message : String(exc);
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'message')) {
      errors.push(`Gate step ${id} is missing 'message' field.`);
    }
    const options = dget(config, 'options', ['approve', 'reject']);
    if (!Array.isArray(options) || !options.length) {
      errors.push(`Gate step ${id}: 'options' must be a non-empty list.`);
    } else if (!options.every((o) => typeof o === 'string')) {
      errors.push(`Gate step ${id}: all options must be strings.`);
    }
    const onReject = dget(config, 'on_reject', 'abort');
    if (onReject !== 'abort' && onReject !== 'skip' && onReject !== 'retry') {
      errors.push(`Gate step ${id}: 'on_reject' must be 'abort', 'skip', or 'retry'.`);
    }
    if (
      dhas(config, 'verdict_input') &&
      (typeof config.verdict_input !== 'string' || !config.verdict_input)
    ) {
      errors.push(`Gate step ${id}: 'verdict_input' must be a non-empty string.`);
    }
    if (
      (onReject === 'abort' || onReject === 'retry') &&
      Array.isArray(options) &&
      options.every((o) => typeof o === 'string')
    ) {
      const rejectChoices = new Set(['reject', 'abort']);
      if (!(options as string[]).some((o) => rejectChoices.has(o.toLowerCase()))) {
        errors.push(
          `Gate step ${id}: on_reject=${pyRepr(onReject)} but options has no 'reject' or 'abort' choice.`,
        );
      }
    }
    return errors;
  }
}
