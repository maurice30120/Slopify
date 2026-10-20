import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { validatePath } from './security.js';

/** Composant FileSystemHandler qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class FileSystemHandler {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(private readonly workspaceRoot: string) {}

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const resolvedPath = validatePath(params.path, this.workspaceRoot);
    let content = await fs.readFile(resolvedPath, 'utf8');

    if (
      (params.line !== undefined && params.line !== null)
      || (params.limit !== undefined && params.limit !== null)
    ) {
      const lines = content.split('\n');
      const startLine = (params.line ?? 1) - 1;
      const endLine = params.limit ? startLine + params.limit : lines.length;
      content = lines.slice(startLine, endLine).join('\n');
    }

    return { content };
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const resolvedPath = validatePath(params.path, this.workspaceRoot);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf8');
    return {};
  }
}
