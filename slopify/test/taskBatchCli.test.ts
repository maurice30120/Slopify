import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runTaskBatchCli } from '../src/taskBatchCli.js';
import { TaskBatchExecutionError, type TaskBatchSnapshot } from '../src/taskBatch.js';
import { ACTIVITY_SIGNAL_EVENT_TYPE, type ActivitySignal } from '../src/activitySignal.js';

const activitySignal: ActivitySignal = {
  version: 1,
  runId: 'run',
  timestamp: '2026-10-13T18:30:00.000Z',
  tasks: [{ taskId: 'sa-6', sentence: 'Câblage CLI du Signal d’activité en cours.', source: 'log' }],
};

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
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
  };
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
  assert.match(result.stdout, /tasks validate-resolution/);
  assert.doesNotMatch(result.stdout, /slopify list|slopify run|--agent|--keep-sandboxes/);
});
test('invalid command arguments never construct an executor service', async () => {
  for (const args of [['run'], ['unknown'], ['run', 'batch', '--concurrency', '10'], ['run', 'batch', '--cwd'],
    ['status', 'run', '--base', 'HEAD'], ['resume', 'run', '--agent', 'pi'], ['run', 'batch', '--strategy', 'manual']]) {
    const code = await runTaskBatchCli(args, output(), '/repo', () => { throw new Error('Service must not be constructed'); });
    assert.equal(code, 1);
  }
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
});
