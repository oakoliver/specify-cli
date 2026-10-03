import { describe, expect, test } from 'bun:test';
import { Console, SELECTION_CHROME_ROWS, selectionPanel, selectionWindow } from '../src/console.js';

const options = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`agent-${i}`, `Agent ${i}`]));

function render(selected: number, rows: number, start = 0) {
  const { panel, start: next } = selectionPanel(options, 'Choose your AI integration:', selected, rows, start);
  const text = new Console({ width: 80, color: false }).renderToString([panel], { end: '' });
  return { lines: text.split('\n'), start: next };
}

describe('selection picker viewport', () => {
  test('the panel for 41 options fits a 24-row terminal', () => {
    const { lines } = render(0, 24);
    // The picker prints a blank line before the panel.
    expect(lines.length + 1).toBeLessThanOrEqual(24);
    expect(lines.join('\n')).toContain('▶');
    expect(lines.join('\n')).toContain('more');
  });

  test('the selected option stays visible while scrolling down and back up', () => {
    let start = 0;
    for (const selected of [0, 5, 14, 15, 30, 40, 39, 20, 3, 0]) {
      const view = render(selected, 24, start);
      start = view.start;
      const marked = view.lines.find((l) => l.includes('▶'));
      expect(marked).toContain(`agent-${selected} `);
    }
  });

  test('a short list shows every option without indicators', () => {
    const few = { a: 'A', b: 'B', c: 'C' };
    const { panel } = selectionPanel(few, 'Pick', 2, 24);
    const text = new Console({ width: 80, color: false }).renderToString([panel], { end: '' });
    expect(text).not.toContain('more');
    expect(text).toContain('▶');
  });

  test('selectionWindow keeps its position while the selection is inside it', () => {
    expect(selectionWindow(41, 3, 24 - SELECTION_CHROME_ROWS, 0)).toEqual({ start: 0, end: 15, hiddenAbove: 0, hiddenBelow: 26 });
    expect(selectionWindow(41, 15, 15, 0).start).toBe(1);
    expect(selectionWindow(41, 10, 15, 5).start).toBe(5);
    expect(selectionWindow(41, 2, 15, 5).start).toBe(2);
  });
});
