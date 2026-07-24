import {
  AgentSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

import { parseBridgeConfig } from './BridgeConfig.js';
import { SandcastleBridgeAgent } from './BridgeAgent.js';
import { defaultSandcastleRuntime } from './DefaultSandcastleRuntime.js';

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[sandcastle-acp-bridge] ${message}\n`);
}

console.log = (...values: unknown[]) => {
  process.stderr.write(`${values.map(String).join(' ')}\n`);
};
console.info = console.log;

try {
  const config = parseBridgeConfig(process.argv.slice(2), process.env);
  const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);
  let agent: SandcastleBridgeAgent | undefined;
  const connection = new AgentSideConnection(conn => {
    agent = new SandcastleBridgeAgent(conn, config, defaultSandcastleRuntime);
    return agent;
  }, stream);

  connection.closed
    .then(() => agent?.dispose())
    .catch(reportFatal);
} catch (error) {
  reportFatal(error);
  process.exitCode = 1;
}
