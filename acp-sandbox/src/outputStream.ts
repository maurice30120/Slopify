import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { SandboxAgentKind } from './runtime.js';

type Update = SessionNotification['update'];

/** Frames CLI JSONL across arbitrary pipe chunks without exposing tool payloads. */
export class SandboxOutputStream {
  private buffer = '';

  constructor(
    private readonly agent: SandboxAgentKind,
    private readonly emit: (update: Update) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      this.line(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
    }
  }

  flush(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      // Keep compatibility with plain-text executors and older saved checkpoints.
      this.text('agent_message_chunk', line + '\n');
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (this.agent === 'opencode') {
      if (event.type === 'reasoning') this.text('agent_thought_chunk', event.part?.text);
      if (event.type === 'text') this.text('agent_message_chunk', event.part?.text);
    } else if (this.agent === 'vibe') {
      if (event.type === 'reasoning') this.text('agent_thought_chunk', event.text);
      if (event.type === 'message' && event.role === 'assistant' && Array.isArray(event.content)) {
        const text = (event.content as unknown[])
          .filter((block: unknown): block is { type: string; text: string } => (
            typeof block === 'object'
            && block !== null
            && 'type' in block
            && 'text' in block
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string'
          ))
          .map((block: { type: string; text: string }) => block.text)
          .join('');
        this.text('agent_message_chunk', text);
      }
    } else if (event.type === 'item.completed') {
      if (event.item?.type === 'reasoning') this.text('agent_thought_chunk', event.item.text);
      if (event.item?.type === 'agent_message') this.text('agent_message_chunk', event.item.text);
    }
  }

  private text(sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: unknown): void {
    if (typeof text === 'string' && text) {
      this.emit({ sessionUpdate, content: { type: 'text', text } });
    }
  }
}
