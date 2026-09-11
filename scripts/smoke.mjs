import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareGitHubSmoke, exerciseGitHubSmoke } from './github-smoke.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const launcher = packaged && process.argv.includes('--launcher');
const screenshotPrefix = packaged ? 'gitdesk-packaged' : 'gitdesk';
const temp = await mkdtemp(join(tmpdir(), 'gitdesk-desktop-smoke-'));
const repoPath = join(temp, 'Atlas workspace');
const profile = join(temp, 'profile');
const env = { ...process.env, GITDESK_USER_DATA: profile, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') };
for (const key of Object.keys(env)) {
  if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/.test(key)) delete env[key];
}
delete env.ELECTRON_RUN_AS_NODE;
delete env.GITDESK_DEV_URL;
let app;
const git = (...args) => execFileSync('git', args, { cwd: repoPath, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await mkdir(repoPath);
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  git('init', '-b', 'main');
  git('config', 'user.name', 'GitDesk Smoke Test');
  git('config', 'user.email', 'gitdesk-test@example.invalid');
  await mkdir(join(repoPath, 'src'));
  await writeFile(join(repoPath, 'src', 'app.ts'), [
    "import { createWorkspace } from './workspace';",
    '',
    'export const config = {',
    "  name: 'Atlas',",
    "  theme: 'light',",
    '  autosave: false,',
    '};',
    '',
    'export function start() {',
    '  return createWorkspace(config);',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(repoPath, 'README.md'), '# Atlas\n\nA thoughtful space for your next idea.\n');
  git('add', '--', 'src/app.ts', 'README.md');
  git('commit', '-m', 'Create workspace foundation', '-m', 'Add the initial application and project guide.');
  await writeFile(join(repoPath, 'src', 'app.ts'), [
    "import { createWorkspace } from './workspace';",
    "import { restoreSession } from './session';",
    '',
    'export const config = {',
    "  name: 'Atlas',",
    "  theme: 'system',",
    '  autosave: true,',
    '  restoreTabs: true,',
    '};',
    '',
    'export async function start() {',
    '  const session = await restoreSession();',
    '  return createWorkspace({ ...config, session });',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(repoPath, 'README.md'), '# Atlas\n\nA thoughtful space for your next idea.\n\n## Getting started\n\nOpen your workspace and pick up where you left off.\n');
  await writeFile(join(repoPath, '.gitignore'), 'node_modules/\ndist/\n');
  app = await electron.launch({
    executablePath: launcher ? join(project, 'gitdesk.sh') : packaged ? join(project, 'release/linux-unpacked/gitdesk') : undefined,
    args: packaged ? [] : [project], cwd: project, env, timeout: 30_000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.gitdesk && document.querySelector('#root')?.children.length));
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  const sandbox = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation };
  });
  expect(sandbox).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repoPath);
  await page.getByRole('button', { name: /Add a repository/ }).click();
  await page.getByRole('button', { name: 'Choose…', exact: true }).click();
  await expect(page.getByLabel('Repository folder', { exact: true })).toHaveValue(repoPath);
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByText('Atlas workspace', { exact: true }).first().waitFor();
  const repoId = await page.evaluate(async () => {
    const result = await window.gitdesk.call('getAppState', {});
    if (!result.ok || !result.data.selectedRepoId) throw new Error('No selected repository after Add');
    return result.data.selectedRepoId;
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'HTTPS authentication', exact: true }).click();
  await page.getByLabel('HTTPS repository URL', { exact: true }).fill('https://gitlab.company.invalid/team/project.git');
  await page.getByLabel('Email or username', { exact: true }).fill('fixture@company.invalid');
  const secretInput = page.getByLabel('Password or personal access token', { exact: true });
  await expect(secretInput).toHaveAttribute('type', 'password');
  await secretInput.fill('fixture-only-session-secret');
  await page.getByRole('button', { name: 'Use credentials for this session', exact: true }).click();
  await expect(page.getByText('Credentials prepared for fixture@company.invalid.', { exact: false })).toBeVisible();
  await expect(secretInput).toHaveValue('');
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-authentication.png`) });
  const credentials = await page.evaluate(() => window.gitdesk.call('getHttpsAuth', { url: 'https://gitlab.company.invalid/team/project.git' }));
  expect(credentials.ok && credentials.data.username).toBe('fixture@company.invalid');
  expect(JSON.stringify(credentials)).not.toContain('fixture-only-session-secret');
  await page.getByRole('button', { name: 'Forget session credentials', exact: true }).click();
  await expect(page.getByText('Credentials prepared for fixture@company.invalid.', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'View changes to src/app.ts' }).click();
  await expect(page.getByText('restoreSession', { exact: false }).first()).toBeVisible();
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-changes.png`) });
  const invalid = await page.evaluate(async () => window.gitdesk.call('status', { repoId: '../../outside' }));
  expect(invalid.ok).toBe(false);
  await page.getByRole('checkbox', { name: 'Stage src/app.ts', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Unstage src/app.ts', exact: true })).toBeChecked();
  await appendFile(join(repoPath, 'src', 'app.ts'), '// Included from a partially staged file.\n');
  await page.keyboard.press('Control+r');
  await page.getByRole('checkbox', { name: 'Stage remaining changes in src/app.ts (partially staged)', exact: true }).click();
  await expect.poll(() => git('diff', '--cached', '--', 'src/app.ts')).toContain('Included from a partially staged file.');
  expect(git('diff', '--', 'src/app.ts')).toBe('');
  await page.getByLabel('Commit summary', { exact: true }).fill('Restore the previous session');
  await page.getByLabel('Commit description', { exact: true }).fill('Preserve workspace preferences between launches.');
  await page.getByRole('button', { name: 'Commit 1 staged file', exact: true }).click();
  await expect.poll(() => git('log', '-1', '--format=%s').trim()).toBe('Restore the previous session');
  expect(git('show', '--pretty=', '--name-only', 'HEAD').trim()).toBe('src/app.ts');
  expect(git('status', '--porcelain')).toContain('README.md');
  expect(git('status', '--porcelain')).toContain('.gitignore');
  await expect(page.getByLabel('Commit summary', { exact: true })).toHaveValue('');
  await page.getByLabel('Commit summary', { exact: true }).fill('Restore the previous session');
  await page.getByLabel('Commit description', { exact: true }).fill('Preserve workspace preferences between launches.\n\nClarify the session restoration behavior.');
  await page.getByRole('checkbox', { name: 'Amend last commit', exact: true }).check();
  await page.getByRole('button', { name: 'Amend last commit', exact: true }).click();
  await page.getByRole('button', { name: 'Amend commit', exact: true }).click();
  await expect.poll(() => git('log', '-1', '--format=%b')).toContain('Clarify the session restoration behavior.');
  expect(git('status', '--porcelain')).toContain('README.md');
  expect(git('status', '--porcelain')).toContain('.gitignore');
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByText('Restore the previous session', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Copy commit SHA', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy commit SHA', exact: true })).toContainText('Copied');
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(git('rev-parse', 'HEAD').trim());
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-history.png`) });
  const state = await page.evaluate(() => window.gitdesk.call('getAppState', {}));
  expect(state.ok && state.data.selectedRepoId).toBe(repoId);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-light.png`) });
  await page.getByRole('tab', { name: /Changes/ }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
  await page.waitForFunction(() => window.innerWidth === 900 && window.innerHeight === 600);
  await expect(page.getByRole('button', { name: 'Commit staged changes', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-compact.png`) });
  expect(errors).toEqual([]);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840));
  await page.waitForFunction(() => window.innerWidth === 1280 && window.innerHeight === 840);
  const githubFixture = await prepareGitHubSmoke(app, temp, env, repoPath);
  await exerciseGitHubSmoke({ app, page, fixture: githubFixture, project, screenshotPrefix, originalRepoId: repoId, originalRepoPath: repoPath, env });
  expect(errors).toEqual([]);
  console.log(`${packaged ? 'Packaged' : 'Built'} desktop smoke passed${launcher ? ' through gitdesk.sh' : ''}: sandbox, Add via folder dialog, HTTPS session credentials/forgetting, real diff, file/partial staging, commit and confirmed message-only amend, excluded files, history, clipboard, theme settings, compact window, persistence, IPC validation, GitHub token login/rejection/logout, repository pages/filter, real clone, confirmed private creation, dirty publish guard, real publication, browser device code/cancellation (mock API, local bare remotes only).`);
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
