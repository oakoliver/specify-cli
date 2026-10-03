/**
 * Tests for progress step rendering
 */

import { describe, test, expect } from 'bun:test';
import { printStep, printInfo } from '../src/ui.js';

/** Runs fn with stdout as a TTY or a pipe and returns the screen lines it leaves. */
function screen(isTTY: boolean, fn: () => void): string[] {
  let out = '';
  const log = console.log;
  const write = process.stdout.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  console.log = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  try {
    fn();
  } finally {
    console.log = log;
    process.stdout.write = write;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }

  // Apply the cursor-up / carriage-return / erase-line sequences printStep uses.
  const lines: string[] = [''];
  let row = 0;
  for (const [token] of out.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/\x1b\[1A|\x1b\[2K|\r|\n|[^\x1b\r\n]+/g)) {
    if (token === '\x1b[1A') row = Math.max(0, row - 1);
    else if (token === '\x1b[2K') lines[row] = '';
    else if (token === '\r') continue;
    else if (token === '\n') { row++; lines[row] ??= ''; }
    else lines[row] += token;
  }
  return lines.filter((line) => line !== '');
}

describe('printStep', () => {
  test('on a terminal the result replaces the pending line', () => {
    expect(screen(true, () => {
      printStep('Copying templates', 'pending');
      printStep('Copying templates', 'done');
      printStep('Initializing git', 'pending');
      printStep('Initializing git', 'error');
    })).toEqual(['  ✓ Copying templates', '  ✗ Initializing git']);
  });

  test('in a pipe only the result is printed', () => {
    expect(screen(false, () => {
      printStep('Copying templates', 'pending');
      printStep('Copying templates', 'done');
    })).toEqual(['  ✓ Copying templates']);
  });

  test('a line printed in between is not overwritten', () => {
    expect(screen(true, () => {
      printStep('Copying templates', 'pending');
      printInfo('using bundled templates');
      printStep('Copying templates', 'done');
    })).toEqual(['  ○ Copying templates', '  using bundled templates', '  ✓ Copying templates']);
  });
});
