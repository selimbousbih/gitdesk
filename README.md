# GitDesk

A standalone, local-first desktop Git client with a familiar two-pane workflow.
GitDesk uses **real system Git**, not a simulated repository. Optional GitHub
account features use GitHub's API; ordinary Git workflows remain provider-independent.
Its interface, branding, and icon are original; it is not affiliated with GitHub.

## Screenshots

### Review and stage changes

![GitDesk changes view showing staged and working-tree diffs](assets/screenshots/changes.png)

| Browse commit history | Browse GitHub repositories |
| --- | --- |
| ![GitDesk history view showing commits and a unified diff](assets/screenshots/history.png) | ![GitDesk GitHub repository browser](assets/screenshots/github-repositories.png) |

## Run

Requirements: **Git 2.30+**, **Node.js 24 LTS**, and a graphical desktop.
Git must be available on the application's `PATH`.

```sh
npm install
npm run build
npm start
```

For development, run `npm run dev`. Vite reloads renderer changes; restart this
command after changing the main process or preload.

On Linux, after packaging:

```sh
npm run package:linux
./release/linux-unpacked/gitdesk
```

`release/GitDesk-0.1.0-x64.tar.gz` is a portable distribution: extract the **entire**
archive and run `gitdesk` from the extracted folder. Keep its resources beside
the executable. It bundles Electron and does not require Node or npm at runtime.
System Git is still required. `./gitdesk.sh` runs the packaged app if present,
otherwise the built source app.

This checkout also has a project-local Node toolchain, if Node is not installed:

```sh
export PATH="$PWD/.tools/node-v24.21.0-linux-x64/bin:$PATH"
npm run dev
```

The toolchain is local and ignored by Git; it is not part of the source
distribution. No global package or operating-system setting is changed.

## Scope and platform notes

GitDesk is a practical Git client, **not complete GitHub Desktop parity**.
It has no pull-request/issue UI, embedded terminal, three-way merge editor,
line/hunk staging, interactive rebase editor, LFS management, submodule management,
or GitHub Enterprise account browsing. Use your existing tools for those workflows.
Binary files are identified rather than rendered as text; oversized diffs show
an explicit limit rather than silently truncating (2 MiB from Git, up to 12,000
rendered lines). Merge commits are shown relative to their first parent; reverting
or cherry-picking a merge commit requires a mainline choice in command-line Git.
Filenames must be valid UTF-8. Newline-containing filenames work for Git actions,
but cannot be added as ignore patterns. Skipping an empty cherry-pick/rebase step
requires command-line Git; Continue and Abort are available in GitDesk. Unusual
repository layouts that expose real Git metadata as working-tree files outside
`.git` are refused. Normal repositories and linked worktrees are supported.

Network operations support HTTPS, SSH and local directory remotes. Legacy
`git://`, plain HTTP, arbitrary remote helpers, mirror pushes, custom refspecs,
multiple fetch URLs and differing fetch/push destinations are deliberately
rejected rather than guessed. SSH runs non-interactively using the system `ssh`,
SSH configuration and agent. GitDesk does not support a custom SSH executable
or interactive password/host-key prompts. Set up and verify access in a terminal
first. Commands time out explicitly after 90 seconds locally or three minutes
for network work; exceptionally large operations may need command-line Git.
Branch switching, branch creation, integration, checkout, revert and cherry-pick
require a clean working tree, including untracked files. Commit or stash first.

Open in editor uses a `code` or `codium` executable on `PATH`; conflicting files
are opened as text, never launched with a potentially executable OS association.
Open in terminal supports Konsole, GNOME Terminal, macOS Terminal and Windows
Terminal. Missing launchers produce explicit availability errors.
Commit web links recognize github.com, gitlab.com and bitbucket.org; other HTTP
hosts can be opened at the repository level.

Linux packaging is configured for an unpacked portable app and `tar.gz`.
`npm run package:appimage` additionally builds an AppImage where the packaging
host supports it. macOS DMG and Windows NSIS targets are configured for native
build hosts (`npm run package`); those platforms require separate verification
and signing before distribution. On Windows cancellation stops Git itself,
not necessarily every child process; Linux process-tree cancellation is tested.
No release is signed or published by this
project. Linux Chromium sandbox support depends on the host. Do not disable the
sandbox or change OS settings to work around a packaging or launch failure.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run package:linux
npm run test:packaged
```

Integration tests create disposable repositories and local bare remotes under
the system temporary directory. They do not operate on your repositories or
access an external network service. HTTPS authentication tests additionally use
`openssl` and a local TLS-protected smart-Git server to verify actual
email/password clone, push, fetch and pull, rejected credentials, URL isolation,
expiry and private-cache cleanup. The desktop smoke test runs the built app in a
temporary profile and repository, checks Electron isolation, repository/diff/
history flows and real commits, and writes screenshots to `test-results/`.
It requires a working graphical session. `GITDESK_USER_DATA=/absolute/path`
selects a separate application profile for manual isolated testing.
`test:packaged` repeats the same UI and Git workflow using
`release/linux-unpacked/gitdesk` itself, rather than the development Electron
binary. Neither desktop test disables the Chromium sandbox.
GitHub tests use mocked provider responses and disposable local remotes, including
private creation/publication, clone, partial-push recovery, input guards, device
login, credential storage and account failures. No real GitHub repository is
created or pushed by tests.

## Layout

`src/main/git/` owns repository operations; `src/main/` owns Electron and native
actions; `src/shared/` defines the typed, runtime-validated command contract;
`src/preload/` exposes the isolated bridge; `src/renderer/` is the React desktop
interface. Build products and dependencies are ignored by Git.

MIT licensed. See [LICENSE](LICENSE).
