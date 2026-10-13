import * as path from 'node:path';

export type InitHost = string;

export interface InitOptions {
  cwd: string;
  host?: InitHost;
  yes: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

export function parseInitArgs(argv: string[], baseCwd = process.cwd()): InitOptions {
  let cwd = baseCwd;
  let host: InitHost | undefined;
  let yes = false;
  let json = false;
  let verbose = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--cwd') {
      const next = argv[++index];
      if (!next || next.startsWith('-')) throw new Error('--cwd requires a path.');
      cwd = path.resolve(baseCwd, next);
    }
    else if (value === '--host') {
      const next = argv[++index];
      if (!next || next.startsWith('-')) throw new Error('--host requires one of: pi, codex, all.');
      host = next;
    }
    else if (value === '--yes') yes = true;
    else if (value === '--json') json = true;
    else if (value === '--verbose') verbose = true;
    else if (value === '--help' || value === '-h') help = true;
    else if (value.startsWith('-')) throw new Error(`Unknown init option "${value}".`);
    else throw new Error(`slopify init does not accept positional argument "${value}".`);
  }
  return { cwd, host, yes, json, verbose, help };
}
