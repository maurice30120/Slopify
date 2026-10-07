import type { SessionNotification } from '@agentclientprotocol/sdk';

/** Type métier SessionUpdateListener utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SessionUpdateListener = (update: SessionNotification) => void;

/** Composant SessionUpdateHandler qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class SessionUpdateHandler {
  private readonly listeners = new Set<SessionUpdateListener>();

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  handleUpdate(update: SessionNotification): void {
    for (const listener of this.listeners) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      listener(update);
    }
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  dispose(): void {
    this.listeners.clear();
  }
}
