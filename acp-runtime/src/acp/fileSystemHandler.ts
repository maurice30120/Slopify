import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { validatePath } from './security.js';

export class FileSystemHandler {
  constructor(private readonly workspaceRoot: string, private readonly readOnlyRoots: readonly string[] = []) {}

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const resource = this.readOnlyRoots.find(root => isWithin(root, params.path));
    const resolvedPath = validatePath(params.path, resource ?? this.workspaceRoot);
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

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const absolute = path.resolve(this.workspaceRoot, params.path);
    if (this.readOnlyRoots.some(root => isWithin(root, absolute))) throw new Error('Run resources are read-only.');
    const resolvedPath = validatePath(params.path, this.workspaceRoot);
    if (this.readOnlyRoots.some(root => isWithin(root, resolvedPath))) throw new Error('Run resources are read-only.');
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf8');
    return {};
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
