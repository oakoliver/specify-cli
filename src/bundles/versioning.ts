/**
 * @oakoliver/specify-cli - Bundle versioning
 *
 * SemVer parsing and constraint evaluation. Upstream builds on Python's
 * ``packaging`` (PEP 440 ``Version`` / ``SpecifierSet``); this module ports the
 * subset of those semantics the bundler relies on, with zero dependencies.
 *
 * Port of ``specify_cli/bundles/versioning.py``.
 *
 * @module bundles/versioning
 */

import { BundlerError } from './index.js';
import { pyStrRepr } from './pycompat.js';

// ============================================================================
// PEP 440 Version (port of packaging.version.Version)
// ============================================================================

const VERSION_PATTERN = new RegExp(
  '^\\s*v?' +
    '(?:' +
    '(?:(?<epoch>[0-9]+)!)?' +
    '(?<release>[0-9]+(?:\\.[0-9]+)*)' +
    '(?<pre>[-_\\.]?(?<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_\\.]?(?<pre_n>[0-9]+)?)?' +
    '(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_\\.]?(?<post_l>post|rev|r)[-_\\.]?(?<post_n2>[0-9]+)?))?' +
    '(?<dev>[-_\\.]?(?<dev_l>dev)[-_\\.]?(?<dev_n>[0-9]+)?)?' +
    ')' +
    '(?:\\+(?<local>[a-z0-9]+(?:[-_\\.][a-z0-9]+)*))?' +
    '\\s*$',
  'i',
);

/** ``packaging.version.InvalidVersion``. */
export class InvalidVersion extends Error {
  override name = 'InvalidVersion';
}

/** ``packaging.specifiers.InvalidSpecifier``. */
export class InvalidSpecifier extends Error {
  override name = 'InvalidSpecifier';
}

type LocalPart = number | string;

/** A comparable PEP 440 version. */
export class Version {
  readonly epoch: number;
  readonly release: number[];
  readonly pre: [string, number] | null;
  readonly post: number | null;
  readonly dev: number | null;
  readonly local: LocalPart[] | null;

  constructor(version: string) {
    const match = VERSION_PATTERN.exec(version);
    if (!match || !match.groups) {
      throw new InvalidVersion(`Invalid version: ${pyStrRepr(version)}`);
    }
    const g = match.groups;
    this.epoch = g.epoch ? Number.parseInt(g.epoch, 10) : 0;
    this.release = g.release.split('.').map((p) => Number.parseInt(p, 10));
    if (g.pre_l) {
      let label = g.pre_l.toLowerCase();
      if (label === 'alpha') label = 'a';
      else if (label === 'beta') label = 'b';
      else if (label === 'c' || label === 'pre' || label === 'preview') label = 'rc';
      this.pre = [label, g.pre_n ? Number.parseInt(g.pre_n, 10) : 0];
    } else {
      this.pre = null;
    }
    if (g.post) {
      const n = g.post_n1 ?? g.post_n2;
      this.post = n ? Number.parseInt(n, 10) : 0;
    } else {
      this.post = null;
    }
    this.dev = g.dev ? (g.dev_n ? Number.parseInt(g.dev_n, 10) : 0) : null;
    this.local = g.local
      ? g.local
          .toLowerCase()
          .split(/[-_.]/)
          .map((p) => (/^[0-9]+$/.test(p) ? Number.parseInt(p, 10) : p))
      : null;
  }

  get isPrerelease(): boolean {
    return this.pre !== null || this.dev !== null;
  }

  get isPostrelease(): boolean {
    return this.post !== null;
  }

  /** ``Version.public``. */
  get public(): string {
    return this.toString().split('+')[0];
  }

  /** ``Version.base_version``. */
  get baseVersion(): string {
    const epoch = this.epoch ? `${this.epoch}!` : '';
    return epoch + this.release.join('.');
  }

  toString(): string {
    let out = this.epoch ? `${this.epoch}!` : '';
    out += this.release.join('.');
    if (this.pre) out += `${this.pre[0]}${this.pre[1]}`;
    if (this.post !== null) out += `.post${this.post}`;
    if (this.dev !== null) out += `.dev${this.dev}`;
    if (this.local) out += `+${this.local.join('.')}`;
    return out;
  }

  /** Negative / zero / positive like ``cmp``. */
  compare(other: Version): number {
    return compareKeys(this.key(), other.key());
  }

  equals(other: Version): boolean {
    return this.compare(other) === 0;
  }

  private key(): KeyPart[] {
    const release = [...this.release];
    while (release.length > 1 && release[release.length - 1] === 0) release.pop();
    let pre: KeyPart;
    if (this.pre === null && this.post === null && this.dev !== null) pre = NEG_INF;
    else if (this.pre === null) pre = POS_INF;
    else pre = [PRE_ORDER[this.pre[0]] ?? 0, this.pre[1]];
    const post: KeyPart = this.post === null ? NEG_INF : this.post;
    const dev: KeyPart = this.dev === null ? POS_INF : this.dev;
    const local: KeyPart =
      this.local === null
        ? NEG_INF
        : this.local.map((p) => (typeof p === 'number' ? [1, p, ''] : [0, 0, p]) as KeyPart);
    return [this.epoch, release, pre, post, dev, local];
  }
}

const NEG_INF = Symbol('-inf');
const POS_INF = Symbol('+inf');
const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };
type KeyPart = number | string | symbol | KeyPart[];

function compareKeys(a: KeyPart, b: KeyPart): number {
  if (a === b) return 0;
  if (a === NEG_INF) return -1;
  if (b === NEG_INF) return 1;
  if (a === POS_INF) return 1;
  if (b === POS_INF) return -1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

// ============================================================================
// PEP 440 Specifier / SpecifierSet (port of packaging.specifiers)
// ============================================================================

const SPEC_RE = /^\s*(~=|===|==|!=|<=|>=|<|>)\s*(\S+?)\s*$/;
const ARBITRARY_RE = /^\s*===\s*([^\s;)]*)\s*$/;
const RELEASE_ONLY_TAIL = /^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*\.\*$/i;

function versionSplit(version: string): string[] {
  const result: string[] = [];
  const bang = version.indexOf('!');
  let rest = version;
  if (bang >= 0) {
    result.push(version.slice(0, bang));
    rest = version.slice(bang + 1);
  } else {
    result.push('0');
  }
  for (const item of rest.split('.')) {
    const m = /^([0-9]+)((?:a|b|c|rc)[0-9]+)$/.exec(item);
    if (m) result.push(m[1], m[2]);
    else result.push(item);
  }
  return result;
}

function isNumeric(segment: string): boolean {
  return /^[0-9]+$/.test(segment);
}

function padVersion(left: string[], right: string[]): [string[], string[]] {
  const leftRel: string[] = [];
  let i = 0;
  while (i < left.length && isNumeric(left[i])) leftRel.push(left[i++]);
  const leftRest = left.slice(i);
  const rightRel: string[] = [];
  let j = 0;
  while (j < right.length && isNumeric(right[j])) rightRel.push(right[j++]);
  const rightRest = right.slice(j);
  const lp = [...leftRel, ...Array(Math.max(0, rightRel.length - leftRel.length)).fill('0')];
  const rp = [...rightRel, ...Array(Math.max(0, leftRel.length - rightRel.length)).fill('0')];
  return [
    [...lp, ...leftRest],
    [...rp, ...rightRest],
  ];
}

class Specifier {
  readonly operator: string;
  readonly version: string;

  constructor(spec: string) {
    const arbitrary = ARBITRARY_RE.exec(spec);
    if (arbitrary && arbitrary[1]) {
      this.operator = '===';
      this.version = arbitrary[1];
      return;
    }
    const match = SPEC_RE.exec(spec);
    if (!match || match[1] === '===') {
      throw new InvalidSpecifier(`Invalid specifier: ${pyStrRepr(spec)}`);
    }
    const [, op, ver] = match;
    const invalid = () => new InvalidSpecifier(`Invalid specifier: ${pyStrRepr(spec)}`);
    const body = ver.replace(/^v/i, '');
    if (op === '==' || op === '!=') {
      if (ver.endsWith('.*')) {
        if (!RELEASE_ONLY_TAIL.test(body)) {
          // packaging permits pre/post/dev segments before ``.*``; validate them.
          try {
            new Version(ver.slice(0, -2));
          } catch {
            throw invalid();
          }
          if (ver.includes('+')) throw invalid();
        }
      } else {
        try {
          new Version(ver);
        } catch {
          throw invalid();
        }
      }
    } else {
      let parsed: Version;
      try {
        parsed = new Version(ver);
      } catch {
        throw invalid();
      }
      if (parsed.local) throw invalid();
      if (op === '~=' && parsed.release.length < 2) throw invalid();
    }
    this.operator = op;
    this.version = ver;
  }

  contains(prospective: Version): boolean {
    switch (this.operator) {
      case '===':
        return prospective.toString().toLowerCase() === this.version.toLowerCase();
      case '==':
        return this.equal(prospective, this.version);
      case '!=':
        return !this.equal(prospective, this.version);
      case '~=':
        return this.compatible(prospective);
      case '<=':
        return new Version(prospective.public).compare(new Version(this.version)) <= 0;
      case '>=':
        return new Version(prospective.public).compare(new Version(this.version)) >= 0;
      case '<': {
        const spec = new Version(this.version);
        if (!(prospective.compare(spec) < 0)) return false;
        if (!spec.isPrerelease && prospective.isPrerelease) {
          if (new Version(prospective.baseVersion).equals(new Version(spec.baseVersion))) return false;
        }
        return true;
      }
      case '>': {
        const spec = new Version(this.version);
        if (!(prospective.compare(spec) > 0)) return false;
        if (!spec.isPostrelease && prospective.isPostrelease) {
          if (new Version(prospective.baseVersion).equals(new Version(spec.baseVersion))) return false;
        }
        if (prospective.local !== null) {
          if (new Version(prospective.baseVersion).equals(new Version(spec.baseVersion))) return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private equal(prospective: Version, spec: string): boolean {
    if (spec.endsWith('.*')) {
      const normalizedProspective = new Version(prospective.public).toString();
      const specNoWild = spec.slice(0, -2).replace(/^v/i, '');
      const normalizedSpec = /^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*$/.test(specNoWild)
        ? specNoWild.replace(/(^|[.!])0+(?=\d)/g, '$1')
        : new Version(specNoWild).toString();
      const splitSpec = versionSplit(normalizedSpec);
      const splitProspective = versionSplit(normalizedProspective);
      const [paddedProspective] = padVersion(splitProspective, splitSpec);
      const shortened = paddedProspective.slice(0, splitSpec.length);
      return shortened.join('.') === splitSpec.join('.');
    }
    const specVersion = new Version(spec);
    const candidate = specVersion.local ? prospective : new Version(prospective.public);
    return candidate.equals(specVersion);
  }

  private compatible(prospective: Version): boolean {
    const parts = versionSplit(new Version(this.version).toString()).slice(1);
    const prefixParts: string[] = [];
    for (const p of parts) {
      if (p.startsWith('post') || p.startsWith('dev')) break;
      prefixParts.push(p);
    }
    prefixParts.pop();
    const epoch = new Version(this.version).epoch;
    const prefix = (epoch ? `${epoch}!` : '') + prefixParts.join('.') + '.*';
    return (
      new Version(prospective.public).compare(new Version(this.version)) >= 0 &&
      this.equal(prospective, prefix)
    );
  }
}

/** ``packaging.specifiers.SpecifierSet`` (``contains`` with ``prereleases=True``). */
export class SpecifierSet {
  private readonly specs: Specifier[];

  constructor(specifiers = '') {
    this.specs = specifiers
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => new Specifier(s));
  }

  /** ``contains(version, prereleases=True)``. */
  contains(version: Version): boolean {
    return this.specs.every((s) => s.contains(version));
  }
}

// ============================================================================
// Bundler helpers
// ============================================================================

// Common SemVer prerelease spellings (``1.2.3-rc1``, ``1.2.3-alpha.1``) that
// PEP 440 rejects verbatim. Normalized to PEP 440 before parsing.
const PRERELEASE_PATTERN = /^([0-9]+\.[0-9]+\.[0-9]+)[-.]?(alpha|beta|a|b|rc)[-.]?([0-9]+)(.*)$/i;

function normalizeSemver(value: string): string {
  const text = String(value);
  const normalized = text.slice(0, 1) === 'v' || text.slice(0, 1) === 'V' ? text.slice(1) : text;
  const match = PRERELEASE_PATTERN.exec(normalized);
  if (!match) return normalized;
  const [, base, label, number, rest] = match;
  const lower = label.toLowerCase();
  const pep440 = lower === 'alpha' ? 'a' : lower === 'beta' ? 'b' : lower;
  return `${base}${pep440}${number}${rest}`;
}

/** Parse a version string into a comparable {@link Version}. */
export function parseVersion(value: string): Version {
  try {
    return new Version(normalizeSemver(value));
  } catch (exc) {
    if (exc instanceof InvalidVersion) {
      throw new BundlerError(`Invalid version '${value}': ${exc.message}`, { cause: exc });
    }
    throw exc;
  }
}

const SPECIFIER_CLAUSE = /^\s*(===|==|~=|!=|<=|>=|<|>)?\s*(.*?)\s*$/s;

function normalizeConstraint(value: string): string {
  const clauses: string[] = [];
  for (const raw of String(value).split(',')) {
    if (!raw.trim()) continue;
    const match = SPECIFIER_CLAUSE.exec(raw)!;
    const operator = match[1] ?? '';
    clauses.push(`${operator}${normalizeSemver(match[2])}`);
  }
  return clauses.join(',');
}

/** Parse a version constraint such as ``>=0.9.0`` into a {@link SpecifierSet}. */
export function parseConstraint(value: string): SpecifierSet {
  try {
    return new SpecifierSet(normalizeConstraint(value));
  } catch (exc) {
    if (exc instanceof InvalidSpecifier) {
      throw new BundlerError(`Invalid version constraint '${value}': ${exc.message}`, { cause: exc });
    }
    throw exc;
  }
}

/**
 * Return true if *installed* satisfies *constraint* (e.g. ``">=0.9.0"``).
 * Pre-releases are allowed so a dev/pre build of Spec Kit still counts.
 */
export function satisfies(installed: string, constraint: string): boolean {
  const spec = parseConstraint(constraint);
  const version = parseVersion(installed);
  return spec.contains(version);
}

const SEMVER_RE = new RegExp(
  '^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)' +
    '(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)' +
    '(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
    '(?:\\+(?:[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
);

/**
 * Return true only for a full ``MAJOR.MINOR.PATCH`` SemVer string. An optional
 * leading ``v`` or ``V`` is tolerated.
 */
export function isSemver(value: string): boolean {
  const text = String(value);
  const core = text.slice(0, 1) === 'v' || text.slice(0, 1) === 'V' ? text.slice(1) : text;
  // Python's ``$`` also matches before a single trailing newline.
  return SEMVER_RE.test(core.endsWith('\n') ? core.slice(0, -1) : core);
}
