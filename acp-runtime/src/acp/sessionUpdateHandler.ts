import type { SessionNotification } from '@agentclientprotocol/sdk';

export type SessionUpdateListener = (update: SessionNotification) => void;

export class SessionUpdateHandler {
  private readonly listeners = new Set<SessionUpdateListener>();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    for (const listener of this.listeners) {
      listener(update);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
