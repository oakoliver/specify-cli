/**
 * @oakoliver/specify-cli - TUI Components
 *
 * Terminal UI components for styled output.
 * Uses @oakoliver/lipgloss for styling.
 *
 * @module ui
 */

import { Style } from '@oakoliver/lipgloss';

// ============================================================================
// Styles
// ============================================================================

/** Title style - bold blue */
export const titleStyle = new Style().bold(true).foreground('12');

/** Success style - green */
export const successStyle = new Style().foreground('10');

/** Error style - red */
export const errorStyle = new Style().foreground('9');

/** Warning style - yellow */
export const warningStyle = new Style().foreground('11');

/** Dim style - gray */
export const dimStyle = new Style().foreground('8');

/** Accent style - cyan */
export const accentStyle = new Style().foreground('14');

// ============================================================================
// Banner with True Color Gradient
// ============================================================================

const BANNER_LINES = [
  ' ___  ____  ____  ___  ____  ____  _  _ ',
  '/ __)(  _ \\( ___)/ __)(_  _)( ___)( \\/ )',
  '\\__ \\ )___/ )__)( (__  _)(_  )__)  \\  / ',
  '(___/(__)  (____)\\___)(____)(__)   (__) ',
];

/**
 * Interpolate between two RGB colors.
 */
function lerpColor(
  start: [number, number, number],
  end: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(start[0] + (end[0] - start[0]) * t),
    Math.round(start[1] + (end[1] - start[1]) * t),
    Math.round(start[2] + (end[2] - start[2]) * t),
  ];
}

/**
 * Convert RGB to hex string for lipgloss.
 */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Render a line with horizontal true color gradient.
 */
function renderGradientLine(line: string, startColor: [number, number, number], endColor: [number, number, number]): string {
  let result = '';
  const len = line.length;

  for (let i = 0; i < len; i++) {
    const char = line[i];
    if (char === ' ') {
      result += char;
      continue;
    }

    const t = len > 1 ? i / (len - 1) : 0;
    const [r, g, b] = lerpColor(startColor, endColor, t);
    const color = rgbToHex(r, g, b);
    const style = new Style().foreground(color).bold(true);
    result += style.render(char);
  }

  return result;
}

// Gradient colors: cyan → magenta → orange (vibrant spectrum)
const GRADIENT_STOPS: [number, number, number][] = [
  [0, 255, 255],    // Cyan
  [138, 43, 226],   // Blue-Violet
  [255, 0, 128],    // Hot Pink
  [255, 165, 0],    // Orange
];

/**
 * Get interpolated color from multi-stop gradient.
 */
function getGradientColor(t: number): [number, number, number] {
  const segments = GRADIENT_STOPS.length - 1;
  const segment = Math.min(Math.floor(t * segments), segments - 1);
  const localT = (t * segments) - segment;
  return lerpColor(GRADIENT_STOPS[segment], GRADIENT_STOPS[segment + 1], localT);
}

/**
 * Print the SPECIFY banner with true color gradient.
 */
export function printBanner(): void {
  console.log();

  for (let lineIdx = 0; lineIdx < BANNER_LINES.length; lineIdx++) {
    const line = BANNER_LINES[lineIdx];
    const lineT = BANNER_LINES.length > 1 ? lineIdx / (BANNER_LINES.length - 1) : 0;

    // Vertical gradient: shift the horizontal gradient based on line position
    const startT = lineT * 0.3; // Offset start
    const endT = 0.7 + lineT * 0.3; // Offset end

    const startColor = getGradientColor(startT);
    const endColor = getGradientColor(endT);

    console.log(renderGradientLine(line, startColor, endColor));
  }

  console.log();
}

// ============================================================================
// Progress Steps
// ============================================================================

/**
 * Print a step with status indicator.
 * @param name - Step name
 * @param status - 'pending' | 'done' | 'error'
 */
export function printStep(name: string, status: 'pending' | 'done' | 'error' | 'skip'): void {
  let icon: string;
  let style: Style;

  switch (status) {
    case 'done':
      icon = '✓';
      style = successStyle;
      break;
    case 'error':
      icon = '✗';
      style = errorStyle;
      break;
    case 'skip':
      icon = '○';
      style = dimStyle;
      break;
    default:
      icon = '○';
      style = dimStyle;
  }

  console.log(`  ${style.render(icon)} ${name}`);
}

/**
 * Print a success message.
 */
export function printSuccess(message: string): void {
  console.log();
  console.log(successStyle.render(`✓ ${message}`));
}

/**
 * Print an error message.
 */
export function printError(message: string): void {
  console.log();
  console.log(errorStyle.render(`✗ ${message}`));
}

/**
 * Print a warning message.
 */
export function printWarning(message: string): void {
  console.log(warningStyle.render(`⚠ ${message}`));
}

/**
 * Print an info message.
 */
export function printInfo(message: string): void {
  console.log(dimStyle.render(`  ${message}`));
}

// ============================================================================
// Next Steps
// ============================================================================

/**
 * Print next steps after init completes.
 */
export function printNextSteps(projectPath: string, agent: string): void {
  console.log();
  console.log(titleStyle.render('Next Steps'));
  console.log();
  console.log(`  1. ${dimStyle.render('cd')} ${projectPath}`);
  console.log(`  2. ${dimStyle.render('Create your first feature:')} .specify/scripts/bash/create-new-feature.sh "my-feature"`);
  console.log(`  3. ${dimStyle.render('Run')} /speckit.specify ${dimStyle.render('in your')} ${agent} ${dimStyle.render('session')}`);
  console.log();
}
