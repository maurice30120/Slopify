import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Exercise scheduler/agent contracts with the production recreate lifecycle.
 * Reuse, container isolation and reset checks have dedicated pool fixtures.
 */
export async function configureRecreatedWorkers(repositoryPath: string): Promise<void> {
  const directory = path.join(repositoryPath, '.slopify');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'runtime.yaml'),
    'workers:\n  size: 10\n  lifecycle: recreate\n  mounts: []\n');
}
