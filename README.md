# T3 Code

> This is the [`SoulSniper-V2/t3code`](https://github.com/SoulSniper-V2/t3code) fork of [upstream T3 Code](https://github.com/pingdotgg/t3code). The additions below are maintained in this fork's source; they are not features of the upstream project.

## What this fork adds

- **Cline and Command Code providers**, including usage reporting from their local transcripts.
- **Cross-chat context:** type `@` in the composer to reference another thread, including archived threads. The current agent receives a bounded excerpt of that thread's recent conversation.
- **Thread workflows:** set persistent goals with `/goal`, hand a thread to another provider with `/handoff`, fork it with `/fork`, or start an independent thread through the `start_thread` MCP tool in the Synara Agent Gateway integration.
- **Native computer-use tools over MCP:** agents can inspect the active app's accessibility tree, capture screenshots, list or activate desktop apps, click, type, and press keys.
- **Multi-agent pipeline prompt builder:** `/pipeline` prepares a Plan → Build → Review prompt with provider and model choices for each stage, then loads it into the composer to send.
- **Browser Preview Design Mode:** click an element to attach its HTML, CSS, and screenshot to the chat prompt.
- **Changes Walkthrough:** a guided review of the current diff.
- **Issue references:** parse Linear, Jira, GitLab, and GitHub issue links and add their details to the agent's prompt.
- **Provider account switching:** hot-swap between multiple configured provider accounts from the chat composer.
- **Nightly updater fix:** a newer installed nightly is not replaced by an older nightly release.

> **Distribution:** The install commands below point to upstream T3 Code. Download this fork's signed macOS nightly and its update assets from [this fork's releases](https://github.com/SoulSniper-V2/t3code/releases).

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. This fork also adds Cline and Command Code through their local CLIs.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity; this fork also supports Cline and Command Code. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - Cline and Command Code: install and authenticate their CLIs, then enable the providers in Settings.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest upstream version of the desktop app from [T3 Code GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry. To use this fork's additions, download its [macOS nightly](https://github.com/SoulSniper-V2/t3code/releases) instead:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
