import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareGitHubSmoke(app, temp, env, seedPath) {
  const remotes = join(temp, 'github-remotes');
  const clones = join(temp, 'github-clones');
  await mkdir(remotes);
  await mkdir(clones);
  execFileSync('git', ['clone', '--bare', '--', seedPath, join(remotes, 'source.git')], { env, stdio: 'pipe' });
  execFileSync('git', ['config', '--global', `url.${remotes}/.insteadOf`, 'https://github.com/fixture-smoke/'], { env, stdio: 'pipe' });
  await app.evaluate(({ shell }, remoteDirectory) => {
    const { execFileSync } = process.getBuiltinModule('child_process');
    const { join } = process.getBuiltinModule('path');
    const requests = [];
    globalThis.__gitdeskGithubRequests = requests;
    globalThis.__gitdeskGithubOpenedPages = [];
    shell.openExternal = async url => {
      if (!url.startsWith('https://github.com/')) throw new Error('Unexpected external browser target');
      globalThis.__gitdeskGithubOpenedPages.push(url);
    };
    const repo = (name) => ({
      id: name === 'source' ? 1 : name === '.github' ? 2 : 3,
      name, full_name: `fixture-smoke/${name}`, owner: { login: 'fixture-smoke' },
      description: 'Disposable private GitHub workflow fixture', private: true, archived: false,
      default_branch: 'main', updated_at: '2026-06-01T12:00:00Z', permissions: { push: true },
    });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://github.com' && url.pathname === '/login/device/code') {
        return Response.json({ device_code: 'fixture-main-only-device-code', user_code: 'GDSK-TEST', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
      }
      if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') return Response.json({ error: 'authorization_pending' });
      if (url.origin !== 'https://api.github.com') throw new Error('External network prohibited in the desktop smoke test');
      if (init?.headers?.Authorization !== 'Bearer ghp_SmokeFixtureNotARealSecret12345') return Response.json({}, { status: 401 });
      requests.push({ path: url.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/user') return Response.json({ login: 'fixture-smoke', name: 'GitDesk fixture' });
      if (url.pathname === '/user/repos' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (!/^[A-Za-z0-9_-]+$/.test(body.name) || body.private !== true || body.auto_init !== false) throw new Error('Unsafe fixture create');
        execFileSync('git', ['init', '--bare', '--initial-branch=main', '--', join(remoteDirectory, `${body.name}.git`)], { env: process.env, stdio: 'pipe' });
        return Response.json(repo(body.name));
      }
      if (url.pathname === '/user/repos') {
        return url.searchParams.get('page') === '1'
          ? Response.json([repo('source')], { headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } })
          : Response.json([repo('.github')]);
      }
      if (url.pathname === '/repos/fixture-smoke/source') return Response.json(repo('source'));
      throw new Error('Unexpected GitHub fixture route');
    };
  }, remotes);
  expect(await app.evaluate(() => globalThis.__gitdeskGithubRequests)).toEqual([]);
  return { clones, remotes };
}

export async function exerciseGitHubSmoke({ app, page, fixture, project, screenshotPrefix, originalRepoId, originalRepoPath, env }) {
  const openGitHub = async () => {
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'GitHub repositories…', exact: true }).click();
    return page.getByRole('dialog', { name: 'GitHub', exact: true });
  };
  let dialog = await openGitHub();
  const token = dialog.getByLabel('Personal access token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('button', { name: 'Sign in with token', exact: true })).toBeDisabled();
  await token.fill('ghp_WrongFixtureNotARealSecret12345');
  await dialog.getByRole('button', { name: 'Sign in with token', exact: true }).click();
  await expect(dialog.getByText('GitHub rejected this credential. Sign in again with a valid token.')).toBeVisible();
  await expect(token).toHaveValue('');
  await token.fill('ghp_SmokeFixtureNotARealSecret12345');
  await dialog.getByRole('button', { name: 'Sign in with token', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Load repositories', exact: true })).toBeVisible();
  await expect(token).toHaveCount(0);
  const account = await page.evaluate(() => window.gitdesk.call('githubAccount', {}));
  expect(account.ok && account.data.user.login).toBe('fixture-smoke');
  expect(JSON.stringify(account)).not.toContain('ghp_');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  dialog = await openGitHub();
  await dialog.getByRole('button', { name: 'Load repositories', exact: true }).click();
  await dialog.getByRole('button', { name: 'Load more repositories', exact: true }).click();
  const filter = dialog.getByLabel('Filter loaded GitHub repositories', { exact: true });
  await filter.fill('.github');
  await expect(dialog.getByRole('button', { name: /fixture-smoke\/\.github/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /fixture-smoke\/source/ })).toHaveCount(0);
  await filter.fill('');
  await dialog.getByRole('button', { name: /fixture-smoke\/source/ }).click();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture.clones);
  await dialog.getByRole('button', { name: 'Choose…', exact: true }).click();
  await expect(dialog.getByLabel('Parent folder', { exact: true })).toHaveValue(fixture.clones);
  await dialog.getByLabel(/^Local folder name/).fill('Cloned GitHub workspace');
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-github-repositories.png`) });
  await dialog.getByRole('button', { name: 'Clone repository', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Cloned GitHub workspace', { exact: true }).first()).toBeVisible();
  expect(await readFile(join(fixture.clones, 'Cloned GitHub workspace', 'README.md'), 'utf8')).toContain('# Atlas');

  dialog = await openGitHub();
  await dialog.getByRole('button', { name: 'Create private', exact: true }).click();
  await dialog.getByLabel(/^GitHub repository name/).fill('created-empty');
  await dialog.getByLabel(/^Description/).fill('Private empty fixture repository');
  await dialog.getByRole('button', { name: 'Create private repository', exact: true }).click();
  let confirmation = page.getByRole('dialog', { name: 'Create a private GitHub repository?', exact: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await app.evaluate(() => globalThis.__gitdeskGithubRequests.filter(item => item.method === 'POST'))).toEqual([]);
  await dialog.getByRole('button', { name: 'Create private repository', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Create a private GitHub repository?', exact: true });
  await confirmation.getByRole('button', { name: 'Create private repository', exact: true }).click();
  await expect(dialog.getByText('Created fixture-smoke/created-empty', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'github.com/fixture-smoke/created-empty', exact: true }).click();
  expect(await app.evaluate(() => globalThis.__gitdeskGithubOpenedPages)).toEqual(['https://github.com/fixture-smoke/created-empty']);
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-github-created.png`) });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  const selected = await page.evaluate(repoId => window.gitdesk.call('selectRepository', { repoId }), originalRepoId);
  expect(selected.ok).toBe(true);
  await expect(page.getByText('Atlas workspace', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Publish repository', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'GitHub', exact: true });
  await expect(dialog.getByRole('button', { name: 'Publish private repository', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Commit, stash, or remove all local changes, including untracked files, before publishing.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  execFileSync('git', ['add', '--', 'README.md', '.gitignore'], { cwd: originalRepoPath, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Prepare disposable publication fixture'], { cwd: originalRepoPath, env, stdio: 'pipe' });
  await page.keyboard.press('Control+r');
  await expect.poll(async () => {
    const result = await page.evaluate(repoId => window.gitdesk.call('status', { repoId }), originalRepoId);
    return result.ok && result.data.files.length;
  }).toBe(0);
  await page.getByRole('button', { name: 'Publish repository', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'GitHub', exact: true });
  await dialog.getByLabel(/^GitHub repository name/).fill('published-workspace');
  await expect(dialog.getByLabel(/^New remote name/)).toHaveValue('origin');
  await dialog.getByRole('button', { name: 'Publish private repository', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Publish this repository to GitHub?', exact: true });
  await confirmation.getByRole('button', { name: 'Publish private repository', exact: true }).click();
  await expect(dialog.getByText('Current branch published and upstream configured.', { exact: true })).toBeVisible();
  const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originalRepoPath, env, encoding: 'utf8' }).trim();
  expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: join(fixture.remotes, 'published-workspace.git'), env, encoding: 'utf8' }).trim()).toBe(localHead);
  const published = await page.evaluate(repoId => window.gitdesk.call('status', { repoId }), originalRepoId);
  expect(published.ok && published.data.upstream).toBe('origin/main');
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-github-published.png`) });
  await dialog.getByRole('button', { name: 'Account', exact: true }).click();
  await dialog.getByRole('button', { name: 'Sign out of GitHub', exact: true }).click();
  await expect(dialog.getByLabel('Personal access token', { exact: true })).toHaveValue('');
  const signedOut = await page.evaluate(() => window.gitdesk.call('githubAccount', {}));
  expect(signedOut.ok && signedOut.data.user).toBeNull();
  await dialog.getByText('Browser login / OAuth client ID', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Continue with browser', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^OAuth client ID/).fill('fixture_client_id_12345');
  await dialog.getByRole('button', { name: 'Continue with browser', exact: true }).click();
  await expect(dialog.getByLabel('GitHub sign-in code', { exact: true })).toHaveText('GDSK-TEST');
  expect(await page.content()).not.toContain('fixture-main-only-device-code');
  await dialog.getByRole('button', { name: 'Open GitHub in browser', exact: true }).click();
  expect(await app.evaluate(() => globalThis.__gitdeskGithubOpenedPages)).toContain('https://github.com/login/device');
  await page.screenshot({ path: join(project, `test-results/${screenshotPrefix}-github-device.png`) });
  await dialog.getByRole('button', { name: 'Cancel browser sign-in', exact: true }).click();
  await expect(dialog.getByLabel('GitHub sign-in code', { exact: true })).toHaveCount(0);
  await dialog.getByText('Browser login / OAuth client ID', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue with browser', exact: true }).click();
  await expect(dialog.getByLabel('GitHub sign-in code', { exact: true })).toHaveText('GDSK-TEST');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => {
    const result = await page.evaluate(() => window.gitdesk.call('githubPollLogin', {}));
    return !result.ok && result.error.code;
  }).toBe('GITHUB_LOGIN_MISSING');
}
