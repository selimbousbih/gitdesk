import { build } from 'esbuild';

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'out/main/index.cjs',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'out/preload/index.cjs',
  external: ['electron'],
  sourcemap: true,
});
