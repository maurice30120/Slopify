import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityGitSignal } from '../src/activitySignalGit.js';
import { activityTaskPhrase } from '../src/activityTaskPhrase.js';

const now = new Date('2026-10-14T10:00:00Z');
const lastSignalAt = new Date('2026-10-14T09:56:30Z');
const clonePath = '/clone/t83';

/** Un delta git de clone modifié, tel que produit par activitySignalGit. */
const modifiedClone: ActivityGitSignal = {
  phrase: '2 fichiers modifiés (src/a.ts, src/b.ts)',
  snapshot: { clonePath, statuses: { 'src/a.ts': ' M', 'src/b.ts': ' M' } },
};

/** Un clone intact : delta lu, aucune différence depuis le signal précédent. */
const intactClone: ActivityGitSignal = {
  phrase: null,
  snapshot: { clonePath, statuses: {} },
};

test('a chatty log yields the phrase of source log', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: 'npm run build\nles tests tournent encore\n',
    git: modifiedClone,
    now,
    lastSignalAt,
  });
  assert.equal(signal.source, 'log');
  assert.equal(signal.sentence, 'les tests tournent encore');
  assert.equal(signal.taskId, 't83-chaine-sources');
});

test('a silent log with a modified clone yields the phrase of source git', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: '',
    git: modifiedClone,
    now,
    lastSignalAt,
  });
  assert.equal(signal.source, 'git');
  assert.equal(signal.sentence, '2 fichiers modifiés (src/a.ts, src/b.ts)');
});

test('a failing git delta falls back to “rien de nouveau”', () => {
  const notRead = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: '',
    git: undefined,
    now,
    lastSignalAt,
  });
  assert.equal(notRead.source, 'none');
  assert.equal(notRead.sentence, 'rien de nouveau depuis 3 minutes');

  const commandFailed = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: '',
    git: { phrase: null, snapshot: null },
    now,
    lastSignalAt,
  });
  assert.equal(commandFailed.source, 'none');
  assert.equal(commandFailed.sentence, 'rien de nouveau depuis 3 minutes');
});

test('simultaneous log and git failures yield source none without any exception escaping', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: undefined,
    git: undefined,
    now,
    lastSignalAt,
  });
  assert.equal(signal.source, 'none');
  assert.equal(signal.sentence, 'rien de nouveau depuis 3 minutes');
});

test('hostile inputs whose reads throw never let an exception escape', () => {
  const hostile = {
    taskId: 't83-chaine-sources',
    get log(): string | undefined {
      throw new Error('log illisible');
    },
    get git(): ActivityGitSignal | undefined {
      throw new Error('git en échec');
    },
    now,
    get lastSignalAt(): Date {
      throw new Error('instant inconnu');
    },
  };
  const signal = activityTaskPhrase(hostile);
  assert.equal(signal.source, 'none');
  assert.equal(signal.sentence, 'rien de nouveau');
  assert.equal(signal.taskId, 't83-chaine-sources');
});

test('no lastSignalAt and no news yields the defined fallback without a duration', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: '',
    git: intactClone,
    now,
  });
  assert.equal(signal.source, 'none');
  assert.equal(signal.sentence, 'rien de nouveau');
});

test('a silent log with an intact clone yields “rien de nouveau depuis N minutes” of source none', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: '   \n\t\n',
    git: intactClone,
    now,
    lastSignalAt,
  });
  assert.equal(signal.source, 'none');
  assert.equal(signal.sentence, 'rien de nouveau depuis 3 minutes');
});

test('an unreadable log falls back to the git delta', () => {
  const signal = activityTaskPhrase({
    taskId: 't83-chaine-sources',
    log: undefined,
    git: modifiedClone,
    now,
    lastSignalAt,
  });
  assert.equal(signal.source, 'git');
  assert.equal(signal.sentence, '2 fichiers modifiés (src/a.ts, src/b.ts)');
});
