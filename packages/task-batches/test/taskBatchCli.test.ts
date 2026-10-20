import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runTaskBatchCli } from '@slopify/task-batches';
import { TaskBatchExecutionError, type TaskBatchSnapshot } from '@slopify/task-batches';
import { ACTIVITY_SIGNAL_EVENT_TYPE, type ActivitySignal } from '@slopify/activity';
import { activityJournalPath, appendActivitySignal } from '@slopify/activity';
import { formatTaskBatchReport, taskBatchReport } from '@slopify/task-batches';

const activitySignal: ActivitySignal = {
  version: 1,
  runId: 'run',
  timestamp: '2026-10-13T18:30:00.000Z',
  tasks: [{ taskId: 'sa-6', sentence: 'Câblage CLI du Signal d’activité en cours.', source: 'log' }],
};

const cli = fileURLToPath(new URL('../../../../apps/cli/dist/src/cli.js', import.meta.url));
const output = () => {
  const messages: string[] = [];
  const errors: string[] = [];
  return { messages, errors, write: (message: string) => { messages.push(message); }, writeError: (message: string) => { errors.push(message); } };
};
function snapshot(status: TaskBatchSnapshot['status']): TaskBatchSnapshot {
  return {
    version: 1, runId: 'run', repositoryPath: '/repo', status,
    runBaseCommit: 'base', integrationBranch: 'feature/run', createdAt: '', updatedAt: '',
    context: { specFile: 'spec.md', specText: 'spec', batchFile: 'batch.json' }, tasks: [], diagnostics: [],
  };
}
function service(state: TaskBatchSnapshot) {
  return {
    run: async () => state, status: async () => state, resume: async () => state,
    resumeTask: async () => state, resolveConflict: async () => state, validateResolution: async () => state,
    getConflict: async () => undefined, getResolution: async () => undefined,
    recentActivitySignals: async () => [],
    allActivitySignals: async () => [],
  };
}

/** État durable minimal d'un run dans le store, lisible par `tasks status` sans exécuter de tâche. */
function durableRun(runId = 'run-1'): TaskBatchSnapshot {
  return {
    version: 1, runId, repositoryPath: '/repo', status: 'running',
    runBaseCommit: 'base', integrationBranch: `feature/${runId}`,
    createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:05:00.000Z',
    context: { specFile: 'spec.md', specText: 'spec', batchFile: 'batch.json' }, tasks: [], diagnostics: [],
  };
}

function journalSignal(runId: string, minute: number, taskId = 'sa-6'): ActivitySignal {
  return {
    version: 1, runId,
    timestamp: `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`,
    tasks: [{ taskId, sentence: `minute ${minute} : écriture du journal du Signal d’activité`, source: 'log' }],
  };
}

/** Store réel avec l'état durable du run et les signaux écrits directement dans le journal, sans attendre le tick. */
async function storeWithJournal(t: { after(fn: () => Promise<void>): void }, signals: ActivitySignal[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-status-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'run-1';
  await mkdir(path.join(root, runId), { recursive: true });
  await writeFile(path.join(root, runId, 'state.json'), JSON.stringify(durableRun(runId)));
  for (const signal of signals) await appendActivitySignal(activityJournalPath(root, runId), signal);
  return root;
}
for (const status of ['succeeded', 'failed', 'interrupted', 'conflicted'] as const) {
  for (const command of [['run', 'batch.json'], ['resume', 'run'], ['resume-task', 'run', 'task'],
    ['resolve-conflict', 'run'], ['validate-resolution', 'run', 'resolution']]) {
    test(`${command[0]} returns the execution exit code for ${status}`, async () => {
      const sink = output();
      const code = await runTaskBatchCli([...command, '--json'], sink, '/repo', () => service(snapshot(status)));
      assert.equal(code, status === 'succeeded' ? 0 : 2);
      assert.equal(JSON.parse(sink.messages[0]).status, status);
      assert.deepEqual(sink.errors, []);
    });
  }
  test(`status consultation returns zero for ${status}`, async () => {
    assert.equal(await runTaskBatchCli(['status', 'run'], output(), '/repo', () => service(snapshot(status))), 0);
  });
}
for (const args of [['list'], ['run', 'full', 'prompt', '--agent', 'codex'],
  ['resume', 'run', '--agent', 'pi'], ['list', '--help']]) {
  test(`legacy command ${args.join(' ')} is inaccessible and points to V2`, () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /removed.*slopify tasks run.*slopify tasks resume/);
  });
}
test('top-level help exposes only V2 commands', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /tasks run <batch.json>/);
  assert.match(result.stdout, /tasks watch <run-id>/);
  assert.match(result.stdout, /tasks validate-resolution/);
  assert.doesNotMatch(result.stdout, /slopify list|slopify run|--agent|--keep-sandboxes/);
});
test('invalid command arguments never construct an executor service', async () => {
  for (const args of [['run'], ['unknown'], ['run', 'batch', '--concurrency', '10'], ['run', 'batch', '--cwd'],
    ['status', 'run', '--base', 'HEAD'], ['resume', 'run', '--agent', 'pi'], ['run', 'batch', '--strategy', 'manual'],
    ['status', 'run', '--interval', '500'], ['watch', 'run', '--interval', '10']]) {
    const code = await runTaskBatchCli(args, output(), '/repo', () => { throw new Error('Service must not be constructed'); });
    assert.equal(code, 1);
  }
});
test('tasks watch emits only changed states and exits when the run is terminal', async () => {
  const sink = output();
  const states = [snapshot('running'), snapshot('running'), snapshot('succeeded')];
  let polls = 0;
  const code = await runTaskBatchCli(['watch', 'run', '--interval', '100', '--json'], sink, '/repo', () => ({
    ...service(snapshot('running')),
    status: async () => { polls += 1; return states.shift() ?? snapshot('succeeded'); },
  }));
  assert.equal(code, 0);
  assert.equal(polls, 3);
  assert.deepEqual(sink.messages.map(line => JSON.parse(line).status), ['running', 'succeeded']);
  assert.deepEqual(sink.errors, []);
});
test('tasks watch catches all new journal signals after more than ten accrue between polls', async () => {
  const sink = output();
  const states = [snapshot('running'), snapshot('running'), snapshot('succeeded')];
  const signals = Array.from({ length: 22 }, (_, minute) => journalSignal('run', minute));
  const journalReads = [signals.slice(0, 10), signals, signals];
  const code = await runTaskBatchCli(['watch', 'run', '--interval', '100', '--json'], sink, '/repo', () => ({
    ...service(snapshot('running')),
    status: async () => states.shift() ?? snapshot('succeeded'),
    allActivitySignals: async () => journalReads.shift() ?? signals,
  }));
  assert.equal(code, 0);
  const updates = sink.messages.map(line => JSON.parse(line));
  assert.deepEqual(updates.map(update => update.activitySignals.length), [10, 12, 0]);
  assert.deepEqual(updates[1].activitySignals, signals.slice(10));
});
test('SIGINT reaches task execution and handlers are removed after returning interrupted', async () => {
  const before = process.listenerCount('SIGINT');
  const state = snapshot('interrupted');
  const code = await runTaskBatchCli(['run', 'batch'], output(), '/repo', () => ({
    ...service(state),
    run: async (_file, options) => {
      process.emit('SIGINT');
      assert.equal(options?.signal?.aborted, true);
      return state;
    },
  }));
  assert.equal(code, 2);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('durable conflict or resolution execution errors return two with the snapshot', async () => {
  const state = snapshot('conflicted');
  for (const command of [['resume', 'run'], ['resolve-conflict', 'run'], ['validate-resolution', 'run', 'resolution']]) {
    const sink = output();
    const stopped = async () => { throw new TaskBatchExecutionError(state, 'resolution stopped'); };
    const code = await runTaskBatchCli([...command, '--json'], sink, '/repo', () => ({
      ...service(state), resume: stopped, resolveConflict: stopped, validateResolution: stopped,
    }));
    assert.equal(code, 2);
    assert.equal(JSON.parse(sink.messages[0]).status, 'conflicted');
  }
});

test('execution announces its run and progress on stderr while stdout remains one final JSON result', async () => {
  const sink = output();
  const code = await runTaskBatchCli(['run', 'batch', '--json'], sink, '/repo', options => {
    return { ...service(snapshot('succeeded')), run: async () => {
      options.onUpdate?.(snapshot('ready'));
      options.onUpdate?.(snapshot('running'));
      assert.equal(sink.messages.length, 0, 'run identification is available before completion');
      assert.equal(JSON.parse(sink.errors[0]).runId, 'run');
      options.onUpdate?.(snapshot('running'));
      options.onUpdate?.(snapshot('succeeded'));
      return snapshot('succeeded');
    } };
  });
  assert.equal(code, 0);
  assert.equal(sink.messages.length, 1);
  assert.deepEqual(sink.errors.map(line => JSON.parse(line).status), ['ready', 'running', 'succeeded']);
  const final = JSON.parse(sink.messages[0]);
  assert.equal(final.status, 'succeeded');
  assert.ok(final.progress);
  assert.ok(Array.isArray(final.issues));
  assert.ok(Array.isArray(final.nextActions));
});

test('generic command errors are machine-readable with --json', async () => {
  const sink = output();
  assert.equal(await runTaskBatchCli(['resume', 'run', '--json'], sink, '/repo', () => ({
    ...service(snapshot('failed')), resume: async () => { throw new Error('Frozen specification is missing'); },
  })), 1);
  assert.equal(JSON.parse(sink.messages[0]).diagnostics[0].message, 'Frozen specification is missing');
  assert.deepEqual(sink.errors, []);
});

test('a service-delivered activity signal is emitted as one dedicated JSON event line on stderr', async () => {
  const sink = output();
  const code = await runTaskBatchCli(['run', 'batch', '--json'], sink, '/repo', options => ({
    ...service(snapshot('succeeded')), run: async () => {
      options.onActivitySignal?.(activitySignal);
      return snapshot('succeeded');
    },
  }));
  assert.equal(code, 0);
  assert.equal(sink.errors.length, 1, 'one JSON object per line for the whole signal');
  assert.ok(sink.errors[0].endsWith('\n'), 'the event line is newline-terminated');
  const event = JSON.parse(sink.errors[0]);
  assert.equal(event.type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.notEqual(event.type, 'progress');
  assert.equal(event.runId, 'run');
  assert.deepEqual(event.signal, activitySignal);
  assert.equal(sink.messages.length, 1, 'stdout keeps one final result');
  assert.equal(JSON.parse(sink.messages[0]).status, 'succeeded');
});

test('in text mode each sentence of the signal becomes one prefixed line on stderr', async () => {
  const sink = output();
  const full: ActivitySignal = {
    version: 1,
    runId: 'run',
    timestamp: '2026-10-13T18:31:00.000Z',
    tasks: [
      { taskId: 'sa-4', sentence: 'Tick minute démarré avec l’exécution.', source: 'log' },
      { taskId: 'sa-5', sentence: 'Fenêtre des dix derniers signaux lue.', source: 'git' },
    ],
    grouped: { taskIds: ['sa-1', 'sa-2'], sentence: 'rien de nouveau depuis 3 minutes.', source: 'none' },
    integration: { sentence: 'Intégration de la vague 1 en cours.' },
  };
  const code = await runTaskBatchCli(['run', 'batch'], sink, '/repo', options => ({
    ...service(snapshot('succeeded')), run: async () => {
      options.onActivitySignal?.(full);
      return snapshot('succeeded');
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(sink.errors, [
    '[run run] sa-4 : Tick minute démarré avec l’exécution.\n',
    '[run run] sa-5 : Fenêtre des dix derniers signaux lue.\n',
    '[run run] sa-1, sa-2 : rien de nouveau depuis 3 minutes.\n',
    '[run run] intégration : Intégration de la vague 1 en cours.\n',
  ]);
  assert.equal(sink.messages.length, 1, 'stdout keeps one final result');
});

test('a malformed signal is skipped without breaking execution or the following signals', async () => {
  const sink = output();
  const code = await runTaskBatchCli(['run', 'batch', '--json'], sink, '/repo', options => ({
    ...service(snapshot('succeeded')), run: async () => {
      options.onActivitySignal?.({ version: 2, runId: 'run', timestamp: '', tasks: [] } as unknown as ActivitySignal);
      options.onActivitySignal?.('not even an object' as unknown as ActivitySignal);
      options.onActivitySignal?.(activitySignal);
      return snapshot('succeeded');
    },
  }));
  assert.equal(code, 0);
  assert.equal(sink.errors.length, 1, 'only the well-formed signal reaches stderr');
  assert.equal(JSON.parse(sink.errors[0]).type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.equal(sink.messages.length, 1, 'stdout keeps one final result');
});

test('a failing signal emission never interrupts execution or the following signals', async () => {
  const messages: string[] = [];
  const errors: string[] = [];
  let failing = true;
  const sink = {
    messages,
    errors,
    write: (message: string) => { messages.push(message); },
    writeError: (message: string) => {
      if (message.includes(ACTIVITY_SIGNAL_EVENT_TYPE) && failing) { failing = false; throw new Error('stderr burst'); }
      errors.push(message);
    },
  };
  const code = await runTaskBatchCli(['run', 'batch', '--json'], sink, '/repo', options => ({
    ...service(snapshot('succeeded')), run: async () => {
      options.onActivitySignal?.(activitySignal);
      options.onActivitySignal?.(activitySignal);
      return snapshot('succeeded');
    },
  }));
  assert.equal(code, 0, 'the formatting failure never propagates to execution');
  assert.equal(sink.errors.filter(line => JSON.parse(line).type === ACTIVITY_SIGNAL_EVENT_TYPE).length, 1,
    'the signal after the failure is still emitted');
  assert.equal(sink.messages.length, 1, 'stdout keeps one final result');
});

test('progress events and the final stdout result stay byte-identical while activity signals flow', async () => {
  const scenario = async (withSignals: boolean, args: string[]) => {
    const sink = output();
    await runTaskBatchCli(args, sink, '/repo', options => ({
      ...service(snapshot('succeeded')), run: async () => {
        options.onUpdate?.(snapshot('ready'));
        options.onUpdate?.(snapshot('running'));
        if (withSignals) options.onActivitySignal?.(activitySignal);
        options.onUpdate?.(snapshot('succeeded'));
        return snapshot('succeeded');
      },
    }));
    const isActivity = (line: string) => args.includes('--json')
      ? JSON.parse(line).type === ACTIVITY_SIGNAL_EVENT_TYPE
      : line.startsWith('[run run]');
    return { stdout: sink.messages.join(''), stderr: sink.errors.filter(line => !isActivity(line)) };
  };
  for (const args of [['run', 'batch', '--json'], ['run', 'batch']]) {
    const without = await scenario(false, args);
    const withSignals = await scenario(true, args);
    assert.deepEqual(withSignals.stderr, without.stderr, `progress output unchanged for ${args.join(' ')}`);
    assert.equal(withSignals.stdout, without.stdout, 'stdout keeps one byte-identical final result');
  }
});

test('the tasks help documents the activity signal channel on stderr', async () => {
  const sink = output();
  assert.equal(await runTaskBatchCli(['--help'], sink, '/repo', () => { throw new Error('Service must not be constructed'); }), 0);
  assert.match(sink.messages[0], /activity-signal/);
  assert.match(sink.messages[0], /prefixed sentence/);
  assert.match(sink.messages[0], /tasks watch/);
});

test('status output stays byte-identical in both modes when the journal holds no signal', async (t) => {
  const runId = 'run-1';
  for (const journal of ['absent', 'empty'] as const) {
    const store = await storeWithJournal(t, []);
    if (journal === 'empty') await writeFile(activityJournalPath(store, runId), '');
    for (const json of [false, true]) {
      const sink = output();
      const args = ['status', runId, '--store', store, ...(json ? ['--json'] : [])];
      assert.equal(await runTaskBatchCli(args, sink, '/repo'), 0, `journal ${journal}, json ${json}`);
      const expected = json ? JSON.stringify(taskBatchReport(durableRun(runId), store))
        : formatTaskBatchReport(durableRun(runId), store);
      assert.equal(sink.messages[0], expected, `journal ${journal}: the pre-signal status output is preserved byte for byte`);
      const result = json ? JSON.parse(sink.messages[0]) : undefined;
      assert.equal('activitySignals' in (result ?? {}), false, 'no dedicated field without a signal');
      assert.ok(!sink.messages[0].includes('Recent activity signals:'), 'no signals section without a signal');
      assert.deepEqual(sink.errors, []);
    }
  }
});

test('a journal longer than ten signals keeps only the ten last in the status window', async (t) => {
  const runId = 'run-1';
  const signals = Array.from({ length: 15 }, (_, index) => journalSignal(runId, index + 1));
  const store = await storeWithJournal(t, signals);
  const text = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', store], text, '/repo'), 0);
  const lines = text.messages[0].split('\n');
  const start = lines.indexOf('Recent activity signals:');
  assert.ok(start >= 0);
  const window = lines.slice(start + 1, start + 11);
  assert.equal(window.length, 10, 'only ten signals are kept in text mode');
  assert.deepEqual(window, Array.from({ length: 10 }, (_, index) =>
    `  [2026-10-13T10:${String(index + 6).padStart(2, '0')}:00.000Z] sa-6 : minute ${index + 6} : écriture du journal du Signal d’activité`));
  assert.ok(!lines.slice(start + 11).some(line => line.includes('minute 1 :') || line.includes('minute 5 :')),
    'the five oldest signals are not replayed');
  const json = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', store, '--json'], json, '/repo'), 0);
  const result = JSON.parse(json.messages[0]);
  assert.equal(result.activitySignals.length, 10, 'only ten signals are kept in --json mode');
  assert.deepEqual(result.activitySignals, signals.slice(-10), 'the ten last, in journal order');
});

test('status --json exposes the journal signals of the run in a dedicated field of the final result', async (t) => {
  const runId = 'run-1';
  const signals = Array.from({ length: 10 }, (_, index) => journalSignal(runId, index + 1));
  const store = await storeWithJournal(t, signals);
  const sink = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', store, '--json'], sink, '/repo'), 0);
  const result = JSON.parse(sink.messages[0]);
  assert.deepEqual(result.activitySignals, signals, 'the ten last signals travel in the final result');
  assert.equal(result.runId, runId);
  assert.ok(result.progress, 'the rest of the status result is unchanged');
  assert.ok(Array.isArray(result.issues));
  assert.ok(Array.isArray(result.nextActions));
  assert.deepEqual(sink.errors, []);
});

test('status replays the journal signals of the run as one readable line per signal in journal order', async (t) => {
  const runId = 'run-1';
  const signals: ActivitySignal[] = [
    { version: 1, runId, timestamp: '2026-10-13T10:01:00.000Z',
      tasks: [{ taskId: 'sa-6', sentence: 'Câblage CLI du Signal d’activité en cours.', source: 'log' }] },
    { version: 1, runId, timestamp: '2026-10-13T10:02:00.000Z',
      tasks: [{ taskId: 'sa-4', sentence: 'Tick minute démarré avec l’exécution.', source: 'log' }],
      grouped: { taskIds: ['sa-1', 'sa-2'], sentence: 'rien de nouveau depuis 3 minutes.', source: 'none' },
      integration: { sentence: 'Intégration de la vague 1 en cours.' } },
  ];
  const store = await storeWithJournal(t, signals);
  const sink = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', store], sink, '/repo'), 0);
  const lines = sink.messages[0].split('\n');
  const start = lines.indexOf('Recent activity signals:');
  assert.ok(start >= 0, 'the status report has a signals section');
  assert.deepEqual(lines.slice(start, start + signals.length + 1), [
    'Recent activity signals:',
    '  [2026-10-13T10:01:00.000Z] sa-6 : Câblage CLI du Signal d’activité en cours.',
    '  [2026-10-13T10:02:00.000Z] sa-4 : Tick minute démarré avec l’exécution.; sa-1, sa-2 : rien de nouveau depuis 3 minutes.; intégration : Intégration de la vague 1 en cours.',
  ]);
  assert.deepEqual(sink.errors, []);
});

test('tasks status exposes the worker pool occupancy and replacements in both modes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-workers-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'run-1';
  const state: TaskBatchSnapshot = { ...durableRun(runId), status: 'failed',
    workerPoolConfig: { size: 2, mounts: [], lifecycle: 'reuse' },
    workers: [
      { workerId: 'gen/1', sandboxName: 'slopify-worker-1', agent: 'codex', status: 'retired', taskId: 'ok', attemptId: 'att-1', replacements: 0 },
      { workerId: 'gen/2', sandboxName: 'slopify-worker-2', agent: 'codex', status: 'retained', taskId: 'broken', attemptId: 'att-2', replacements: 1 },
      { workerId: 'gen/3', sandboxName: 'slopify-worker-3', agent: 'codex', status: 'available', replacements: 1 },
    ] };
  await mkdir(path.join(root, runId), { recursive: true });
  await writeFile(path.join(root, runId, 'state.json'), JSON.stringify(state));
  const sink = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', root, '--json'], sink, '/repo'), 0);
  const result = JSON.parse(sink.messages[0]);
  assert.deepEqual(result.workerPool, {
    size: 2, lifecycle: 'reuse',
    occupancy: { available: 1, assigned: 0, cleaning: 0, verifying: 0, retained: 1, retired: 1 },
    replacements: 1,
    workers: [
      { workerId: 'gen/1', agent: 'codex', status: 'retired', taskId: 'ok', attemptId: 'att-1', replacements: 0 },
      { workerId: 'gen/2', agent: 'codex', status: 'retained', taskId: 'broken', attemptId: 'att-2', replacements: 1 },
      { workerId: 'gen/3', agent: 'codex', status: 'available', replacements: 1 },
    ],
  });
  const text = output();
  assert.equal(await runTaskBatchCli(['status', runId, '--store', root], text, '/repo'), 0);
  assert.match(text.messages[0], /Workers: 2 configured, lifecycle reuse; occupancy: 1 available, 0 assigned, 0 cleaning, 0 verifying, 1 retained, 1 retired; 1 replacement during this run/);
  assert.match(text.messages[0], /gen\/2 \(codex\): retained for inspection, task broken \(attempt att-2\)/);
  assert.deepEqual(text.errors, []);
});

test('the tasks help documents the worker pool visibility of status output', async () => {
  const sink = output();
  assert.equal(await runTaskBatchCli(['--help'], sink, '/repo', () => { throw new Error('Service must not be constructed'); }), 0);
  assert.match(sink.messages[0], /worker pool occupancy/);
  assert.match(sink.messages[0], /replacement/);
});

test('resume-task forwards the explicit checkpoint discard decision and the help documents it', async () => {
  const seen: Array<{ taskId: string; discardCheckpoint: boolean | undefined }> = [];
  const state = snapshot('failed');
  const sink = output();
  const code = await runTaskBatchCli(['resume-task', 'run', 'work', '--discard-checkpoint', '--json'], sink, '/repo', () => ({
    ...service(state),
    resumeTask: async (_runId: string, taskId: string, options: { discardCheckpoint?: boolean }) => {
      seen.push({ taskId, discardCheckpoint: options.discardCheckpoint });
      return state;
    },
  }));
  assert.equal(code, 2);
  assert.deepEqual(seen, [{ taskId: 'work', discardCheckpoint: true }]);
  const help = output();
  assert.equal(await runTaskBatchCli(['--help'], help, '/repo', () => { throw new Error('Service must not be constructed'); }), 0);
  assert.ok(help.messages[0].includes('slopify tasks resume-task <run-id> <task-id> [--discard-checkpoint] [--cwd <repository>] [--store <directory>] [--json]'));
  assert.match(help.messages[0], /--discard-checkpoint/);
  assert.match(help.messages[0], /fail-closed/);
  assert.match(help.messages[0], /preuves|evidence/);
});
