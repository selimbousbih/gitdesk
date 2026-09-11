import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitService } from '../src/main/git/service';
import { httpsRepositoryUrl } from '../src/shared/https';
import type { AppEvent } from '../src/shared/api';

const exec = promisify(execFile);
const username = 'developer@company.test';
const password = 'fixture-only:password-9$!123';
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

let root: string;
let server: Server;
let origin: string;
let service: ReturnType<typeof createGitService>;
let events: AppEvent[];
let requests: { path: string; suppliedCredentials: boolean }[];

function fixtureEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/.test(key)) delete env[key];
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, env: fixtureEnvironment(), maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gitdesk-auth-test-'));
  await mkdir(path.join(root, 'home'));
  await writeFile(path.join(root, 'global.config'), `[credential]\n\thelper = store --file=${path.join(root, 'must-not-store')}\n`);
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'home', 'config'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('TMPDIR', root);
  vi.stubEnv('TMP', root);
  vi.stubEnv('TEMP', root);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', path.join(root, 'server.key'), '-out', path.join(root, 'server.crt')]);
  vi.stubEnv('GIT_SSL_CAINFO', path.join(root, 'server.crt'));
  await git(root, ['init', '--bare', '--initial-branch=main', 'remote.git']);
  await git(path.join(root, 'remote.git'), ['config', 'http.receivepack', 'true']);
  requests = [];
  server = createServer({
    key: await readFile(path.join(root, 'server.key')), cert: await readFile(path.join(root, 'server.crt')),
  }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://fixture.test');
    requests.push({ path: url.pathname, suppliedCredentials: Boolean(request.headers.authorization) });
    if (url.pathname.startsWith('/redirect.git')) {
      response.writeHead(302, { Location: `${origin}/remote.git/info/refs?service=git-upload-pack` });
      response.end();
      return;
    }
    if (request.headers.authorization !== expectedAuth || !url.pathname.startsWith('/remote.git/')) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Company GitLab fixture"', 'Content-Type': 'text/plain' });
      response.end('Authentication required');
      return;
    }
    const backend = spawn('git', ['http-backend'], {
      cwd: root, env: {
        ...fixtureEnvironment(), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: request.headers['content-length'] ?? '',
        HTTP_GIT_PROTOCOL: typeof request.headers['git-protocol'] === 'string' ? request.headers['git-protocol'] : '',
        REMOTE_USER: username, SERVER_PROTOCOL: 'HTTP/1.1', HTTPS: 'on',
      }, shell: false,
    });
    let headers = Buffer.alloc(0);
    let started = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (started) { response.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]);
      const index = headers.indexOf('\r\n\r\n');
      if (index < 0) return;
      let status = 200;
      for (const line of headers.subarray(0, index).toString('utf8').split('\r\n')) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.writeHead(status);
      started = true;
      response.write(headers.subarray(index + 4));
    });
    backend.stderr.resume();
    backend.once('error', error => response.destroy(error));
    backend.stdin.on('error', error => response.destroy(error));
    backend.once('close', () => response.end());
    request.pipe(backend.stdin);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture HTTPS server did not start');
  origin = `https://127.0.0.1:${address.port}`;
  events = [];
  service = createGitService({ dataDir: path.join(root, 'profile'), onEvent: event => events.push(event) });
});

afterEach(async () => {
  await service?.dispose();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('company-hosted HTTPS Git authentication', () => {
  it('uses email/password for real clone, push, fetch and pull without storing credentials on disk', async () => {
    const url = `${origin}/remote.git`;
    const { handlers } = service;
    const beforeConfig = await readFile(path.join(root, 'global.config'), 'utf8');
    const status = await handlers.setHttpsCredentials({ url, username, password });
    expect(status).toMatchObject({ username, supported: true });
    expect(status).not.toHaveProperty('password');
    expect(requests).toEqual([]);
    const clone = await handlers.cloneRepository({ url, parentPath: root, name: 'work' });
    await handlers.setIdentity({ repoId: clone.id, name: 'Fixture', email: username });
    await writeFile(path.join(clone.path, 'hello.txt'), 'hello\n');
    await handlers.stage({ repoId: clone.id, paths: ['hello.txt'], stage: true });
    await handlers.commit({ repoId: clone.id, summary: 'Private HTTPS commit', description: '', amend: false });
    await handlers.network({ repoId: clone.id, action: 'push', remote: 'origin' });
    expect(await git(path.join(root, 'remote.git'), ['log', '-1', '--format=%s'])).toBe('Private HTTPS commit');
    const other = await handlers.cloneRepository({ url, parentPath: root, name: 'other' });
    await handlers.setIdentity({ repoId: other.id, name: 'Second Fixture', email: username });
    await writeFile(path.join(other.path, 'second.txt'), 'second\n');
    await handlers.stage({ repoId: other.id, paths: ['second.txt'], stage: true });
    await handlers.commit({ repoId: other.id, summary: 'Second private commit', description: '', amend: false });
    await handlers.network({ repoId: other.id, action: 'push' });
    await handlers.network({ repoId: clone.id, action: 'fetch' });
    await handlers.network({ repoId: clone.id, action: 'pullRebase' });
    expect(await readFile(path.join(clone.path, 'second.txt'), 'utf8')).toBe('second\n');
    expect(requests.some(request => request.suppliedCredentials)).toBe(true);
    expect(await readFile(path.join(root, 'global.config'), 'utf8')).toBe(beforeConfig);
    expect(await readFile(path.join(clone.path, '.git', 'config'), 'utf8')).not.toContain(password);
    expect(await readFile(path.join(root, 'profile', 'state.json'), 'utf8')).not.toContain(password);
    await expect(stat(path.join(root, 'must-not-store'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(events)).not.toContain(password);
    expect(JSON.stringify(events)).not.toContain(Buffer.from(`${username}:${password}`).toString('base64'));
    const cacheDirectories = (await readdir(root)).filter(name => name.startsWith('gitdesk-https-'));
    expect(cacheDirectories).toHaveLength(1);
    const cacheDirectory = path.join(root, cacheDirectories[0]);
    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o700);
    await service.dispose();
    await expect(stat(cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports wrong passwords honestly, clears ready status and allows replacement', async () => {
    const url = `${origin}/remote.git`;
    await service.handlers.setHttpsCredentials({ url, username, password: 'wrong-fixture-secret' });
    await expect(service.handlers.cloneRepository({ url, parentPath: root, name: 'wrong' })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect((await service.handlers.getHttpsAuth({ url })).username).toBeNull();
    expect(JSON.stringify(events)).not.toContain('wrong-fixture-secret');
    await service.handlers.setHttpsCredentials({ url, username, password });
    const repo = await service.handlers.cloneRepository({ url, parentPath: root, name: 'correct' });
    expect((await service.handlers.status({ repoId: repo.id })).unborn).toBe(true);
  });

  it('does not send session credentials to another repository or follow redirects', async () => {
    await service.handlers.setHttpsCredentials({ url: `${origin}/remote.git`, username, password });
    await expect(service.handlers.cloneRepository({ url: `${origin}/sibling.git`, parentPath: root, name: 'sibling' })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(requests.filter(request => request.path.startsWith('/sibling.git')).every(request => !request.suppliedCredentials)).toBe(true);
    requests.length = 0;
    await service.handlers.setHttpsCredentials({ url: `${origin}/redirect.git`, username, password });
    await expect(service.handlers.cloneRepository({ url: `${origin}/redirect.git`, parentPath: root, name: 'redirect' })).rejects.toThrow();
    expect(requests.every(request => request.path.startsWith('/redirect.git'))).toBe(true);
  });

  it('forgets credentials and refuses expired sessions rather than switching accounts', async () => {
    const url = `${origin}/remote.git`;
    await service.handlers.setHttpsCredentials({ url, username, password });
    const originalNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 3601_000);
    expect((await service.handlers.getHttpsAuth({ url })).username).toBeNull();
    await expect(service.handlers.cloneRepository({ url, parentPath: root, name: 'expired' })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(requests).toEqual([]);
    clock.mockRestore();
    await service.handlers.forgetHttpsCredentials({ url });
    expect((await service.handlers.getHttpsAuth({ url })).username).toBeNull();
    await expect(service.handlers.cloneRepository({ url, parentPath: root, name: 'forgotten' })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(requests.every(request => !request.suppliedCredentials)).toBe(true);
  });

  it('validates protocols and credential fields before starting any helper or contacting a host', async () => {
    for (const url of ['http://company.test/team/repo', 'ssh://git@company.test/repo', 'https://user:secret@company.test/repo', 'https://company.test/repo%0Ahost=other.test', 'https://company.test/repo?token=secret']) {
      expect(httpsRepositoryUrl(url)).toBeNull();
      await expect(service.handlers.setHttpsCredentials({ url, username, password })).rejects.toThrow();
    }
    for (const value of ['bad\nhost=other.test', 'bad\0value', 'bad\rvalue']) {
      await expect(service.handlers.setHttpsCredentials({ url: `${origin}/remote.git`, username: value, password })).rejects.toThrow();
      await expect(service.handlers.setHttpsCredentials({ url: `${origin}/remote.git`, username, password: value })).rejects.toThrow();
    }
    expect(requests).toEqual([]);
    expect((await readdir(root)).filter(name => name.startsWith('gitdesk-https-'))).toEqual([]);
  });
});
