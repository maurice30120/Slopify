import assert from 'node:assert/strict';
import test from 'node:test';

import { MarkdownBlockStream } from '../src/markdownBlockStream.js';

// Codes ANSI de déplacement / effacement du curseur (interdits ici).
// Les SGR (couleur) \x1b[...m sont autorisés et exclus de cette vérification.
const CURSOR_CODES = /\x1b\[[0-9]*[ABCDS]|\x1b\[H|\x1b\[[0-9]*J|\x1b\[[0-9]*K|\x1b[78]|\x1b\[\?25[hl]/;

function plain(ansi: string): string {
  return ansi.replace(/\x1b\[[0-9;]*m/g, '');
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function drain(chunks: string[], width = 80): string {
  const stream = new MarkdownBlockStream({ width });
  let out = '';
  for (const chunk of chunks) out += stream.push(chunk);
  out += stream.flush();
  return out;
}

test('renders a heading exactly once across many chunks', () => {
  // Simule le défaut observé : un titre fragmenté en de nombreux chunks.
  const heading = '# Title';
  const chunks = [...heading, '\n\n', 'Body text.'];
  const out = drain(chunks);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  assert.equal(count(plain(out), 'Title'), 1, 'heading rendered exactly once');
  assert.equal(count(plain(out), 'Body text.'), 1, 'paragraph rendered exactly once');
});

test('emits completed blocks as they settle and never rewrites', () => {
  const stream = new MarkdownBlockStream({ width: 80 });
  // Le titre reste le dernier bloc tant que rien ne suit : rien n'est émis.
  assert.equal(stream.push('# Heading\n\n'), '');
  // Un second bloc arrive : le titre devient non-dernier et est émis une fois.
  const first = stream.push('Para one.');
  assert.ok(plain(first).includes('Heading'), 'heading emitted when next block starts');
  // Un troisième chunk étend le paragraphe courant (dernier bloc) : pas de réémission.
  const second = stream.push(' More.');
  assert.ok(!plain(second).includes('Heading'), 'heading not re-emitted');
  const rest = stream.flush();
  const out = first + second + rest;
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  assert.equal(count(plain(out), 'Heading'), 1);
  assert.equal(count(plain(out), 'Para one. More.'), 1, 'last paragraph flushed once, whole');
});

test('holds a list until a later block or flush', () => {
  const out = drain(['- one\n', '- two\n', '- three\n']);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  const text = plain(out);
  assert.equal(count(text, 'one'), 1);
  assert.equal(count(text, 'two'), 1);
  assert.equal(count(text, 'three'), 1);
  assert.ok(text.indexOf('one') < text.indexOf('two'), 'list order preserved');
  assert.ok(text.indexOf('two') < text.indexOf('three'), 'list order preserved');
});

test('emits a table when a following block arrives', () => {
  const stream = new MarkdownBlockStream({ width: 80 });
  const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  assert.equal(stream.push(table), '', 'table held as last block');
  const after = stream.push('\n\nAfter table.');
  assert.ok(plain(after).includes('A') && plain(after).includes('B'), 'table emitted');
  const rest = stream.flush();
  const out = after + rest;
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  assert.equal(count(plain(out), 'After table.'), 1);
});

test('renders a closed code block once', () => {
  const out = drain(['```ts\nconst x = 1\n', '```\n', '\n\nNext.']);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  const text = plain(out);
  assert.equal(count(text, 'const x = 1'), 1, 'code rendered once');
  assert.equal(count(text, 'Next.'), 1);
});

test('renders an incomplete code block without a spurious closing fence', () => {
  // Bloc de code non clôturé : le rendu (streaming) omet la clôture artificielle.
  const out = drain(['```ts\nconst y = 2\n']);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  const text = plain(out);
  assert.equal(count(text, 'const y = 2'), 1);
  // Une seule clôture de fence au plus : ici zéro car le bloc est incomplet.
  const fences = (text.match(/```/g) ?? []).length;
  assert.equal(fences, 1, 'only the opening fence is shown for an incomplete block');
});

test('handles long lines without duplication', () => {
  const longLine = 'This is a very long paragraph that should be emitted exactly once even if it wraps.';
  const out = drain([longLine]);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  assert.equal(count(plain(out), longLine), 1);
});

test('flushes a last block without a trailing newline', () => {
  const out = drain(['# NoNewline']);
  assert.ok(!CURSOR_CODES.test(out), 'no cursor move/erase codes');
  assert.equal(count(plain(out), 'NoNewline'), 1, 'last block without newline flushed once');
});

test('reset clears buffered content without emitting', () => {
  const stream = new MarkdownBlockStream({ width: 80 });
  stream.push('# Aborted\n\n');
  stream.reset();
  assert.equal(stream.flush(), '', 'nothing emitted after reset');
});

test('emits nothing for empty and whitespace-only input', () => {
  const stream = new MarkdownBlockStream({ width: 80 });
  assert.equal(stream.push(''), '');
  assert.equal(stream.push('\n\n'), '');
  assert.equal(stream.flush(), '');
});
