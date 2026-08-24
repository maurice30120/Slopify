import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SANDBOX_EXTENSION_METHODS,
  SandboxAcpExtensionHandler,
  type SandboxExtensionMethod,
} from '../src/index.js';

test('routes every public sandbox ACP extension to an active handler', async () => {
  const calls: SandboxExtensionMethod[] = [];
  const handler = new SandboxAcpExtensionHandler(Object.fromEntries(
    SANDBOX_EXTENSION_METHODS.map(method => [
      method,
      async (params: Record<string, unknown>) => {
        calls.push(method);
        return { method, token: params.token };
      },
    ]),
  ));

  for (const method of SANDBOX_EXTENSION_METHODS) {
    assert.deepEqual(await handler.extMethod(method, { token: 'ok' }), { method, token: 'ok' });
  }
  assert.deepEqual(calls, SANDBOX_EXTENSION_METHODS);
});

test('rejects unknown or inactive sandbox extension methods explicitly', async () => {
  const handler = new SandboxAcpExtensionHandler({});

  await assert.rejects(handler.extMethod('sandbox/unknown', {}), /Unsupported sandbox ACP extension/);
  await assert.rejects(handler.extMethod('sandbox/status', {}), /is not active/);
});
