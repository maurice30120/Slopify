import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PipelineRunStore, PipelineRuntimeEvent } from "./PipelineRuntime";
import type { PipelineRuntimeSnapshot } from "./PipelineV3Types";

export interface FilePipelineRunStoreOptions {
  rootDir: string;
  repositoryId?: string;
}

export class InMemoryPipelineRunStore implements PipelineRunStore {
  private readonly snapshots = new Map<string, PipelineRuntimeSnapshot>();
  private readonly events = new Map<string, PipelineRuntimeEvent[]>();

  async create(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, cloneSnapshot(snapshot));
    this.events.set(snapshot.runId, []);
  }

  async load(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async save(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, cloneSnapshot(snapshot));
  }

  async appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void> {
    const events = this.events.get(runId) ?? [];
    events.push({ ...event });
    this.events.set(runId, events);
  }

  async listResumable(): Promise<PipelineRuntimeSnapshot[]> {
    return [...this.snapshots.values()]
      .filter(snapshot => snapshot.status === "paused" || snapshot.status === "running" || snapshot.status === "failed")
      .map(cloneSnapshot);
  }

  async readEvents(runId: string): Promise<PipelineRuntimeEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }
}

export class FilePipelineRunStore implements PipelineRunStore {
  private readonly runsDir: string;

  constructor(options: FilePipelineRunStoreOptions) {
    const repositoryId = sanitizePathSegment(options.repositoryId ?? "workspace");
    this.runsDir = join(options.rootDir, repositoryId, "runs");
  }

  async create(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    await this.save(snapshot);
    await mkdir(this.runDir(snapshot.runId), { recursive: true });
    await writeFile(this.eventsPath(snapshot.runId), "", { flag: "a", encoding: "utf8" });
  }

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

  async appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void> {
    const path = this.eventsPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });
  }

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

  private runDir(runId: string): string {
    return join(this.runsDir, sanitizePathSegment(runId));
  }

  private snapshotPath(runId: string): string {
    return join(this.runDir(runId), "snapshot.json");
  }

  private eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.ndjson");
  }
}

export function workspacePipelineRunStore(workspaceCwd: string): FilePipelineRunStore {
  return new FilePipelineRunStore({ rootDir: join(workspaceCwd, ".acp", "runs-v3") });
}

export function userPipelineRunStore(userHome: string, repositoryId: string): FilePipelineRunStore {
  return new FilePipelineRunStore({ rootDir: join(userHome, ".acp", "runs-v3"), repositoryId });
}

function sanitizePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function cloneSnapshot(snapshot: PipelineRuntimeSnapshot): PipelineRuntimeSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PipelineRuntimeSnapshot;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}
