# Pi

A small native desktop UI for the [pi coding agent](https://github.com/earendil-works/pi), built with [nsh](https://github.com/longbridge/nsh).

> **Work in progress.** This is an early prototype: storage formats, caches and behavior can change at any time, and backward compatibility is not a goal. There are no data migrations, so state written by an older build may be ignored or start fresh.

## Requirements

- macOS (Apple silicon) or Windows (x64)
- `nsh` 0.5.1 or newer
- `pi` installed for the current user; the app checks `PATH`, npm, nvm, fnm, bun, pnpm, mise, and Homebrew locations (it drives `pi --mode rpc`)

## Download

Prebuilt macOS (Apple silicon) and Windows (x64) archives are on [Releases](https://github.com/liuzhch1/pi-nsh/releases).

## Run

```bash
nsh run . --target macos
nsh run . --target windows
```

Package the app with:

```bash
nsh package . --target macos -o .nsh/out
open .nsh/out/Pi.app
```

## What it does

- Discovers projects from pi's session store under `~/.pi/agent/sessions` on first launch, the home-directory project included.
- Lets you add a project folder and toggle the last five chats of each project (`Show more` reveals the rest).
- Remembers each project's expanded or collapsed sidebar state across launches.
- Hover a project to reveal its new-chat action; right-click it to copy its path or remove it.
- Opens a chat by reading its session file directly; `pi` starts on the first prompt and stays warm across switches (up to three chats, ten minutes idle), so a running turn keeps going when you switch away.
- Pages older history in as you scroll up, and keeps the last eight visited chats in memory with a ten-minute freshness check.
- Caches the session list, so the sidebar appears immediately on launch and refreshes behind it.
- Checks the local history projection against pi's message count when a session starts, and falls back to pi's own history for a newer session format.
- Streams assistant text, thinking, tool calls, and tool output.
- Hover a sent message to copy it or edit it in place; an edit forks the session before that message and resends the revised text.
- Collapses a finished turn's thinking and tool details automatically. Press the collapsed row to inspect them again.
- Exposes the installed pi model catalog and each model's thinking levels from the composer, refreshing the catalog when the window regains focus.

Projects are stored by the nsh app under its own app storage. Removing a project from the sidebar does not delete pi session files.

## Layout

- `App.tsx` — app shell, sidebar, chat timeline, composer, dialogs
- `pi.ts` — pi RPC client, session scanning, model catalog
- `icons.tsx` — small monochrome line icons drawn with nsh's canvas
- `ui.tsx` — theme tokens and shared primitives
- `theme.json` — grayscale light/dark palette

The app asks for read/write access under the home folder because pi runs with the selected project as its working directory. Process execution is limited to `pi`, `env` (to launch a resolved pi with its tool paths), and `osascript` (the folder chooser).

## macOS permissions

`Pi.app` runs `pi` as a child process, so macOS attributes the agent's file access—including files its bash tool touches—to `Pi.app`. macOS asks once per protected folder (Desktop, Documents, Downloads, removable and network volumes). To avoid the prompts, grant `Pi.app` Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then restart it.

`nsh package` ad-hoc signs the bundle, and a rebuild changes its code identity, so macOS can ask again after packaging. Re-add the rebuilt app to Full Disk Access, or package with a stable signing identity.

This differs from tools such as pi-web: a Node server launched from a terminal inherits the terminal's TCC identity (usually already granted), while a packaged app is its own TCC subject. A home-wide scan (`find ~`, a grep from `$HOME`) is the usual reason a prompt appears even for a project outside those folders.
