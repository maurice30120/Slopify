import { fileURLToPath } from 'node:url';

/** Absolute root of the package that owns the bundled init/plugin assets. */
export function projectInitPackageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export { InitService, type InitResult, createInitPlan, type InitPlan, type InitFilePlan } from './initService.js';
export { parseInitArgs, type InitHost } from './initArgs.js';
export { initHelp, runInitCli } from './initCli.js';
