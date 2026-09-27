/**
 * @oakoliver/specify-cli - `specify self upgrade`
 *
 * Port of spec-kit `selfs/command_upgrade.py` (v1.0.12).
 *
 * Exit codes (identical to upstream):
 *   0    success / no-op (already latest, --dry-run, guidance-only paths)
 *   1    target resolution failure or --tag validation failure
 *   2    verification mismatch (installer exited 0 but `specify --version` differs)
 *   3    installer binary missing / not executable
 *   124  installer timeout (SPECIFY_UPGRADE_TIMEOUT_SECS) or real exit 124
 *   *    installer exit code propagated verbatim
 *
 * @module selfs/upgrade
 */

import { console, escapeMarkup } from '../console.js';
import {
  BadParameter,
  FAILURE_INSTALLER_FAILED,
  FAILURE_INSTALLER_INVALID,
  FAILURE_INSTALLER_MISSING,
  FAILURE_INSTALLER_TIMEOUT,
  FAILURE_TARGET_TAG_UNPARSEABLE,
  FAILURE_VERIFICATION_MISMATCH,
  InstallerResultKind,
  buildUpgradePlan,
  canonicalizeVersionText,
  emitFailure,
  emitGuidance,
  installerBinaryName,
  isUpgradableMethod,
  methodLabel,
  parseVersionText,
  renderArgv,
  runInstaller,
  validateTag,
  verifyUpgrade,
} from '../version.js';

export interface SelfUpgradeOptions {
  dryRun?: boolean;
  tag?: string | null;
}

/** Upgrade @oakoliver/specify-cli to the latest release (or a pinned --tag). */
export async function selfUpgrade(opts: SelfUpgradeOptions = {}): Promise<number> {
  const dryRun = opts.dryRun ?? false;
  let tag = opts.tag ?? null;

  if (tag !== null) {
    try {
      tag = validateTag(tag);
    } catch (e) {
      if (e instanceof BadParameter) {
        console.print(escapeMarkup(e.message));
        return 1;
      }
      throw e;
    }
  }

  const [plan, failureReason] = await buildUpgradePlan(tag);

  if (plan === null) {
    if (failureReason === null) {
      throw new Error('internal contract violation: buildUpgradePlan returned (null, null)');
    }
    emitFailure(failureReason);
    return 1;
  }

  if (failureReason !== null) {
    emitFailure(failureReason, { plan });
    return 1;
  }

  if (!isUpgradableMethod(plan.method)) {
    emitGuidance(plan.method, plan.target_tag);
    return 0;
  }

  if (dryRun) {
    console.print('Dry run — no changes will be made.');
    for (const line of plan.preview_summary.split('\n')) console.print(escapeMarkup(line));
    return 0;
  }

  if (plan.installer_argv === null) {
    emitFailure(FAILURE_INSTALLER_MISSING, { plan, installerName: installerBinaryName(plan.method) });
    return 3;
  }

  if (plan.target_tag === null) {
    throw new Error('Upgrade target tag is required for upgradable install methods');
  }
  const targetTag = plan.target_tag;
  const targetVersion = parseVersionText(targetTag);
  if (targetVersion === null) {
    emitFailure(FAILURE_TARGET_TAG_UNPARSEABLE, { plan });
    return 1;
  }
  if (plan.current_version !== 'unknown') {
    const currentVersion = parseVersionText(plan.current_version);
    if (tag === null && currentVersion !== null && !targetVersion.gt(currentVersion)) {
      if (targetVersion.equals(currentVersion)) {
        console.print(`Already on latest release: ${targetTag}`);
      } else {
        console.print(`Already on latest release or newer: ${plan.current_version}`);
      }
      return 0;
    }
    if (tag !== null && currentVersion !== null && targetVersion.equals(currentVersion)) {
      console.print(`Already on requested release: ${targetTag}`);
      return 0;
    }
  }

  const installedVersion = parseVersionText(plan.current_version);
  const verb =
    tag !== null && installedVersion !== null && targetVersion.lt(installedVersion) ? 'Downgrading' : 'Upgrading';
  const argvStr = renderArgv(plan.installer_argv);
  // ADAPTATION: upstream names the distribution "specify-cli".
  console.print(
    escapeMarkup(
      `${verb} @oakoliver/specify-cli ${plan.current_version} → ${plan.target_tag} ` +
        `via ${methodLabel(plan.method)}: ${argvStr}`,
    ),
  );

  const result = runInstaller(plan);
  const installerName = plan.installer_argv[0] ?? null;

  if (result.kind === InstallerResultKind.MISSING) {
    emitFailure(FAILURE_INSTALLER_MISSING, { plan, installerName });
    return 3;
  }
  if (result.kind === InstallerResultKind.INVALID) {
    emitFailure(FAILURE_INSTALLER_INVALID, { plan, installerName });
    return 3;
  }
  if (result.kind === InstallerResultKind.TIMEOUT) {
    emitFailure(FAILURE_INSTALLER_TIMEOUT, { plan });
    return 124;
  }
  if (result.kind !== InstallerResultKind.EXITED || result.returncode === null) {
    throw new Error(`Unknown installer result: ${JSON.stringify(result)}`);
  }
  if (result.returncode !== 0) {
    emitFailure(FAILURE_INSTALLER_FAILED, { plan, installerExit: result.returncode });
    return result.returncode;
  }

  const verified = verifyUpgrade(plan);
  const verifiedVersion = verified !== null ? parseVersionText(verified) : null;
  if (verifiedVersion === null || !verifiedVersion.equals(targetVersion)) {
    emitFailure(FAILURE_VERIFICATION_MISMATCH, { plan, verifiedVersion: verified });
    return 2;
  }

  console.print(
    escapeMarkup(
      `Upgraded @oakoliver/specify-cli: ${canonicalizeVersionText(plan.pre_upgrade_snapshot)} → ` +
        canonicalizeVersionText(verified as string),
    ),
  );
  return 0;
}
