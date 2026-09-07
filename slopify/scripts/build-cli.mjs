import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/bin/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as slopifyCreateRequire } from 'node:module'; const require = slopifyCreateRequire(import.meta.url);" },
});
