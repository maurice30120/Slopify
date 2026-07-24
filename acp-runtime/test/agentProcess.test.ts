import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentProcessManager } from '../src/acp/agentProcess.js';

test('killAgent does not keep the event loop alive with the force-kill fallback', () => {
	const manager = new AgentProcessManager();
	const instance = manager.spawnAgent('sleepy', {
		command: process.execPath,
		args: ['-e', 'setInterval(() => {}, 1000)'],
	});

	let unrefCalled = false;
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		const timer = originalSetTimeout(handler, timeout, ...args) as unknown as NodeJS.Timeout;
		const originalUnref = timer.unref.bind(timer);
		timer.unref = () => {
			unrefCalled = true;
			return originalUnref();
		};
		return timer;
	}) as unknown as typeof globalThis.setTimeout;

	try {
		assert.equal(manager.killAgent(instance.id), true);
		assert.equal(unrefCalled, true);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		instance.process.kill('SIGKILL');
		manager.dispose();
	}
});
