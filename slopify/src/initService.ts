import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { InitHost } from './initArgs.js';

interface AssetEntry { source: string; destination: string }
interface AssetManifest { host?: string; files: AssetEntry[] }
export interface InitFilePlan extends AssetEntry { source: string; destination: string }
export interface InitPlan { target: string; files: InitFilePlan[] }
export interface InitResult { created: string[]; overwritten: string[]; warnings: string[]; result: 'succeeded' }

export class InitService {
  constructor(private readonly options: { packageRoot: string }) {}

  async supportedHosts(): Promise<string[]> {
    const pluginRoot = path.join(this.options.packageRoot, 'plugin');
    const names = await readdir(pluginRoot);
    const hosts: string[] = [];
    for (const name of names) {
      try {
        const manifest = await this.readManifest(path.join(pluginRoot, name, 'manifest.json'));
        if (manifest.host === name) hosts.push(name);
      } catch { /* folders without a valid init manifest are not supported hosts */ }
    }
    return hosts.sort();
  }

  async plan(target: string, selection: InitHost): Promise<InitPlan> {
    const targetPath = await realpath(path.resolve(target));
    const commonRoot = path.join(this.options.packageRoot, 'init');
    const common = await this.readManifest(path.join(commonRoot, 'manifest.json'));
    const supported = await this.supportedHosts();
    const selected = selection === 'all' ? supported : [selection];
    for (const host of selected) if (!supported.includes(host)) throw new Error(`Unsupported host "${host}". Supported hosts: ${supported.join(', ')}, all.`);
    for (const destination of ['.agents', '.agents/skills', 'skills-lock.json']) {
      await this.validateDestination(targetPath, destination);
    }
    const commonFiles = common.files.map(file => this.resolveEntry(commonRoot, file));
    const hostFiles = new Map<string, InitFilePlan[]>();
    for (const host of selected) {
      const root = path.join(this.options.packageRoot, 'plugin', host);
      const manifest = await this.readManifest(path.join(root, 'manifest.json'));
      hostFiles.set(host, manifest.files.map(file => this.resolveEntry(root, file)));
    }
    const plan = createInitPlan(targetPath, selection, supported, commonFiles, hostFiles);
    const files = plan.files;
    const destinations = new Set<string>();
    for (const file of files) {
      if (destinations.has(file.destination)) throw new Error(`Duplicate init destination: ${file.destination}`);
      destinations.add(file.destination);
      await lstat(file.source);
      await this.validateDestination(targetPath, file.destination);
    }
    return plan;
  }

  async apply(plan: InitPlan): Promise<InitResult> {
    const created: string[] = [];
    const overwritten: string[] = [];
    for (const file of plan.files) {
      const destination = path.join(plan.target, file.destination);
      try { await lstat(destination); overwritten.push(file.destination); }
      catch { created.push(file.destination); }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.source, destination);
    }
    return { created, overwritten, warnings: [], result: 'succeeded' };
  }

  private async readManifest(file: string): Promise<AssetManifest> {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray((value as AssetManifest).files)) throw new Error(`Invalid init manifest: ${file}`);
    return value as AssetManifest;
  }

  private resolveEntry(root: string, entry: AssetEntry): InitFilePlan {
    if (!entry || typeof entry.source !== 'string' || typeof entry.destination !== 'string') throw new Error(`Invalid asset entry in ${root}`);
    const source = path.resolve(root, entry.source);
    if (!this.isInside(root, source) || path.isAbsolute(entry.destination) || entry.destination.split(path.sep).includes('..')) throw new Error(`Unsafe init asset path: ${entry.destination}`);
    return { source, destination: entry.destination };
  }

  private async validateDestination(target: string, relative: string): Promise<void> {
    const destination = path.resolve(target, relative);
    if (!this.isInside(target, destination)) throw new Error(`Init destination escapes target: ${relative}`);
    let current = target;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlinked init destination: ${relative}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
  }

  private isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
}

/** Pure planning boundary: selects immutable asset entries without reading or writing the filesystem. */
export function createInitPlan(target: string, selection: InitHost, supported: readonly string[], commonFiles: readonly InitFilePlan[], hostFiles: ReadonlyMap<string, readonly InitFilePlan[]>): InitPlan {
  const selected = selection === 'all' ? supported : [selection];
  for (const host of selected) if (!supported.includes(host)) throw new Error(`Unsupported host "${host}". Supported hosts: ${supported.join(', ')}, all.`);
  return { target, files: [...commonFiles, ...selected.flatMap(host => hostFiles.get(host) ?? [])] };
}
