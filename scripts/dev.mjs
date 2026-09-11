import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

await import('./build-main.mjs');
const server = await createServer();
await server.listen();
const env = { ...process.env, GITDESK_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  await server.close();
  process.exit(code);
}
child.on('error', async (error) => {
  console.error('Unable to start GitDesk:', error.message);
  await close(1);
});
child.on('exit', (code) => void close(code ?? 0));
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
console.log('GitDesk is running. Renderer changes reload automatically; restart for main-process changes.');
