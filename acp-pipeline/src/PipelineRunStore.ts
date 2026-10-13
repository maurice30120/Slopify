import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PipelineRunStore, PipelineRuntimeEvent } from "./PipelineRuntime";
import type { PipelineRuntimeSnapshot } from "./PipelineV3Types";

/** Contrat fonctionnel de FilePipelineRunStoreOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface FilePipelineRunStoreOptions {
  rootDir: string;
  repositoryId?: string;
}

/** Composant InMemoryPipelineRunStore qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class InMemoryPipelineRunStore implements PipelineRunStore {
  private readonly snapshots = new Map<string, PipelineRuntimeSnapshot>();
  private readonly events = new Map<string, PipelineRuntimeEvent[]>();

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async create(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, cloneSnapshot(snapshot));
    this.events.set(snapshot.runId, []);
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  async load(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async save(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, cloneSnapshot(snapshot));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void> {
    const events = this.events.get(runId) ?? [];
    events.push({ ...event });
    this.events.set(runId, events);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async listResumable(): Promise<PipelineRuntimeSnapshot[]> {
    return [...this.snapshots.values()]
      .filter(snapshot => snapshot.status === "paused" || snapshot.status === "running" || snapshot.status === "failed")
      .map(cloneSnapshot);
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  async readEvents(runId: string): Promise<PipelineRuntimeEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  /** Libère le snapshot et l'historique d'événements d'un run terminal éphémère. */
  async delete(runId: string): Promise<void> {
    this.snapshots.delete(runId);
    this.events.delete(runId);
  }
}

/** Composant FilePipelineRunStore qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class FilePipelineRunStore implements PipelineRunStore {
  private readonly runsDir: string;

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(options: FilePipelineRunStoreOptions) {
    const repositoryId = sanitizePathSegment(options.repositoryId ?? "workspace");
    this.runsDir = join(options.rootDir, repositoryId, "runs");
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async create(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    await this.save(snapshot);
    await mkdir(this.runDir(snapshot.runId), { recursive: true });
    await writeFile(this.eventsPath(snapshot.runId), "", { flag: "a", encoding: "utf8" });
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  async load(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    try {
      return JSON.parse(await readFile(this.snapshotPath(runId), "utf8")) as PipelineRuntimeSnapshot;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async save(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    const path = this.snapshotPath(snapshot.runId);
    await mkdir(dirname(path), { recursive: true });
    // Le renommage remplace atomiquement le snapshot : après une interruption,
    // une reprise lit soit l'ancienne version complète, soit la nouvelle, jamais
    // un JSON partiellement écrit.
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void> {
    const path = this.eventsPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async listResumable(): Promise<PipelineRuntimeSnapshot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
    const snapshots = await Promise.all(entries.map(entry => this.load(entry)));
    return snapshots
      .filter((snapshot): snapshot is PipelineRuntimeSnapshot => Boolean(snapshot))
      .filter(snapshot => snapshot.status === "paused" || snapshot.status === "running" || snapshot.status === "failed");
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private runDir(runId: string): string {
    return join(this.runsDir, sanitizePathSegment(runId));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private snapshotPath(runId: string): string {
    return join(this.runDir(runId), "snapshot.json");
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.ndjson");
  }
}

/** Point d'entrée workspacePipelineRunStore du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function workspacePipelineRunStore(workspaceCwd: string): FilePipelineRunStore {
  return new FilePipelineRunStore({ rootDir: join(workspaceCwd, ".acp", "runs-v3") });
}

/** Point d'entrée userPipelineRunStore du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function userPipelineRunStore(userHome: string, repositoryId: string): FilePipelineRunStore {
  return new FilePipelineRunStore({ rootDir: join(userHome, ".acp", "runs-v3"), repositoryId });
}

/** Point d'entrée sanitizePathSegment du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function sanitizePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Point d'entrée cloneSnapshot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function cloneSnapshot(snapshot: PipelineRuntimeSnapshot): PipelineRuntimeSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PipelineRuntimeSnapshot;
}

/** Point d'entrée isMissingFile du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}
