import assert from 'node:assert/strict';
import test from 'node:test';
import { activityPhraseFromAttemptLog } from '../src/activitySignalLogPhrase.js';

const now = new Date('2026-10-14T10:00:00Z');

test('the last significant log line becomes the activity phrase', () => {
  const phrase = activityPhraseFromAttemptLog({
    log: 'npm run build\ncompiling src/activitySignalLogPhrase.ts\nbuild finished in 3s\n',
    now,
  });
  assert.equal(phrase, 'build finished in 3s');
});

test('empty lines are never retained', () => {
  const phrase = activityPhraseFromAttemptLog({
    log: 'première action\n\n   \n\t\n\ndernière action significative\n\n',
    now,
  });
  assert.equal(phrase, 'dernière action significative');
  assert.equal(activityPhraseFromAttemptLog({ log: '\n\n   \n\t\n', now }), undefined);
});

test('single-line raw JSON is never retained', () => {
  const phrase = activityPhraseFromAttemptLog({
    log: '{"event":"progress","pct":50}\ntests are running\n{"final":"state"}\n',
    now,
  });
  assert.equal(phrase, 'tests are running');
  assert.equal(activityPhraseFromAttemptLog({ log: '{"a":1,"b":[2,3]}\n', now }), undefined);
});

test('multi-line pretty-printed JSON blocks are never retained (brace balance tracking)', () => {
  const log = [
    'démarrage des tests',
    '{',
    '  "suites": [',
    '    { "name": "unit", "passed": 11 }',
    '  ]',
    '}',
    '',
  ].join('\n');
  assert.equal(activityPhraseFromAttemptLog({ log, now }), 'démarrage des tests');

  const onlyBlock = ['{', '  "a": 1,', '  "b": [2, 3]', '}', ''].join('\n');
  assert.equal(activityPhraseFromAttemptLog({ log: onlyBlock, now }), undefined);
});

test('letter-less noise is never retained', () => {
  const phrase = activityPhraseFromAttemptLog({
    log: '####  ####\n---- ----\n1234 5678\nun test passe\n#####\n',
    now,
  });
  assert.equal(phrase, 'un test passe');
  assert.equal(activityPhraseFromAttemptLog({ log: '####\n----\n42\n', now }), undefined);
});

test('ANSI escape codes are stripped from the phrase', () => {
  const phrase = activityPhraseFromAttemptLog({
    log: '\x1b[32m✓ 11 tests passent\x1b[0m\n',
    now,
  });
  assert.equal(phrase, '✓ 11 tests passent');
  const osc = activityPhraseFromAttemptLog({
    log: '\x1b[2mwarn: déprécié, ignorer\x1b[22m\n',
    now,
  });
  assert.equal(osc, 'warn: déprécié, ignorer');
});

test('the phrase is truncated to 200 characters on a single line (199 + ellipsis)', () => {
  const long = activityPhraseFromAttemptLog({ log: `${'a'.repeat(250)}\n`, now });
  assert.equal(long?.length, 200);
  assert.ok(long?.endsWith('…'));
  assert.equal(long?.slice(0, 199), 'a'.repeat(199));

  const exact = activityPhraseFromAttemptLog({ log: `${'b'.repeat(200)}\n`, now });
  assert.equal(exact, 'b'.repeat(200));
});

test('fallback "rien de nouveau depuis N minutes" is computed from lastSignalAt with N >= 1', () => {
  const quiet = activityPhraseFromAttemptLog({
    log: '',
    now,
    lastSignalAt: new Date('2026-10-14T09:56:30Z'),
  });
  assert.equal(quiet, 'rien de nouveau depuis 3 minutes');

  const underOneMinute = activityPhraseFromAttemptLog({
    log: '   \n',
    now,
    lastSignalAt: new Date('2026-10-14T09:59:45Z'),
  });
  assert.equal(underOneMinute, 'rien de nouveau depuis 1 minute');
});

test('returns undefined when there is nothing to say', () => {
  assert.equal(activityPhraseFromAttemptLog({ log: '', now }), undefined);
  assert.equal(activityPhraseFromAttemptLog({ log: '{\n  "a": 1\n}\n', now }), undefined);
});

test('the output is always a single line and deterministic', () => {
  const log = '\r\ndernière action\r\nplus rien après\r\n';
  const first = activityPhraseFromAttemptLog({ log, now });
  const second = activityPhraseFromAttemptLog({ log, now });
  assert.equal(first, second);
  assert.ok(!first!.includes('\n'));
  assert.ok(!first!.includes('\r'));
  assert.equal(first, 'plus rien après');
});

test('a multi-line log mixing noise, JSON and prose keeps the last prose line', () => {
  const log = [
    '$ npm test',
    '{"start":true}',
    '###',
    '{',
    '  "suite": "unit",',
    '  "passed": 11',
    '}',
    '---- ----',
    '',
    '11 tests verts, feuille verte',
    '42',
  ].join('\n');
  assert.equal(activityPhraseFromAttemptLog({ log, now }), '11 tests verts, feuille verte');
});
