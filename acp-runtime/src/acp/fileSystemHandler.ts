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
  constructor(private readonly workspaceRoot: string) {}

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

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const resolvedPath = validatePath(params.path, this.workspaceRoot);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf8');
    return {};
  }
}
