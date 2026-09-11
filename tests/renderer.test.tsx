import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView, parseDiff } from '../src/renderer/diff';

describe('unified diff rendering', () => {
  it('counts root-commit additions without imaginary old line numbers', () => {
    const lines = parseDiff('diff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    expect(lines.filter(line => line.kind === 'addition')).toEqual([
      { kind: 'addition', text: 'one', oldNumber: null, newNumber: 1 },
      { kind: 'addition', text: 'two', oldNumber: null, newNumber: 2 },
    ]);
    expect(lines[2].kind).toBe('header');
  });

  it('tracks context, deleted/added ranges and the next hunk independently', () => {
    const lines = parseDiff('@@ -3,2 +3,2 @@\n context\n-old\n+new\n@@ -10,1 +12,0 @@\n-gone\n\\ No newline at end of file\n');
    expect(lines.map(line => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ['hunk', null, null], ['context', 3, 3], ['deletion', 4, null], ['addition', null, 4],
      ['hunk', null, null], ['deletion', 10, null], ['note', null, null],
    ]);
  });

  it('resets hunk parsing between files and preserves actual blank changed lines', () => {
    const lines = parseDiff('@@ -1 +1 @@\n-\n+\ndiff --git a/next b/next\n--- a/next\n+++ b/next\n@@ -1 +1 @@\n-a\n+b\n');
    expect(lines[1]).toMatchObject({ text: '', oldNumber: 1, kind: 'deletion' });
    expect(lines[2]).toMatchObject({ text: '', newNumber: 1, kind: 'addition' });
    expect(lines[4].kind).toBe('header');
    expect(lines[5].kind).toBe('header');
    expect(parseDiff('')).toEqual([]);
  });

  it('escapes repository content rather than interpreting HTML', () => {
    const html = renderToStaticMarkup(<DiffView diff={{
      path: '<script>.tsx', text: '@@ -0,0 +1 @@\n+<script>alert("not executable")</script>\n', binary: false, tooLarge: false,
    }} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
    expect(html).toContain('syntax-string');
    expect(html).toContain('New line 1');
  });

  it('distinguishes binary, empty and oversized files', () => {
    const diff = { path: 'image.png', text: '', tooLarge: false, binary: false };
    expect(renderToStaticMarkup(<DiffView diff={{ ...diff, binary: true }} />)).toContain('Binary file');
    expect(renderToStaticMarkup(<DiffView diff={diff} />)).toContain('No textual changes');
    expect(renderToStaticMarkup(<DiffView diff={{ ...diff, tooLarge: true }} />)).toContain('too large');
  });

  it('labels the display bound instead of silently truncating long diffs', () => {
    const html = renderToStaticMarkup(<DiffView diff={{
      path: 'large.txt', text: '@@ -0,0 +1,1600 @@\n' + '+line\n'.repeat(1600), binary: false, tooLarge: false,
    }} />);
    expect(html).toContain('1,500 of 1,601 lines');
    expect(html).toContain('Show more (up to 12,000)');
  });
});
