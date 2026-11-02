/**
 * @oakoliver/specify-cli - Observe integration-owned writes only while a
 * lifecycle transaction is active.
 *
 * Port of `integrations/_file_changes.py` (spec-kit v1.2.5).
 *
 * ADAPTATION: upstream keeps the observer in a ``ContextVar`` that the
 * external-adapter lifecycle transaction (``_lifecycle._transaction``) sets
 * to journal and roll back writes. That transaction is not ported (see the
 * CHANGELOG: catalog-installed external adapters), so no observer is ever
 * installed by the CLI; the hooks are kept so the call sites match upstream
 * and a future lifecycle port can plug in via {@link setFileChangeObserver}.
 *
 * @module integrations/file-changes
 */

import { unlinkSync, writeFileSync } from 'node:fs';

export type FileChangeObserver = (path: string, before: boolean, removal: boolean) => void;

let observer: FileChangeObserver | null = null;

/** Install (or clear with ``null``) the active observer; returns the previous one. */
export function setFileChangeObserver(next: FileChangeObserver | null): FileChangeObserver | null {
  const previous = observer;
  observer = next;
  return previous;
}

/** The active observer, or ``null``. */
export function getFileChangeObserver(): FileChangeObserver | null {
  return observer;
}

export function beforeFileChange(path: string, opts: { removal?: boolean } = {}): void {
  if (observer !== null) observer(path, true, opts.removal ?? false);
}

export function afterFileChange(path: string): void {
  if (observer !== null) observer(path, false, false);
}

/** Journal a host mutation without claiming the file for uninstall. */
export function changingFile<T>(path: string, fn: () => T, opts: { removal?: boolean } = {}): T {
  beforeFileChange(path, opts);
  const result = fn();
  afterFileChange(path);
  return result;
}

export function writeText(path: string, content: string): void {
  changingFile(path, () => writeFileSync(path, content, 'utf-8'));
}

export function writeBytes(path: string, content: Uint8Array): void {
  changingFile(path, () => writeFileSync(path, content));
}

export function unlink(path: string, opts: { missingOk?: boolean } = {}): void {
  changingFile(
    path,
    () => {
      try {
        unlinkSync(path);
      } catch (e) {
        if (!(opts.missingOk && (e as NodeJS.ErrnoException).code === 'ENOENT')) throw e;
      }
    },
    { removal: true },
  );
}

/** ``lifecycle_owns_rollback``: leave failure cleanup to an active mutation journal. */
export function lifecycleOwnsRollback(): boolean {
  return observer !== null;
}
