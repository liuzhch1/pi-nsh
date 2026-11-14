# Pi

A small native desktop UI for the [pi coding agent](https://github.com/earendil-works/pi), built with [nsh](https://github.com/longbridge/nsh).

## Requirements

- macOS
- `nsh` 0.5.1 or newer
- `pi` on the login shell's `PATH` (this app drives `pi --mode rpc`)

## Run

```bash
nsh run . --target macos
```

Package an app bundle with:

```bash
nsh package . --target macos -o .nsh/out
open .nsh/out/Pi.app
```

## What it does

- Discovers projects from pi's session store under `~/.pi/agent/sessions` on first launch.
- Lets you add a project folder and toggle the last five chats of each project (`Show more` reveals the rest).
- Hover a project to reveal its new-chat action; right-click it to copy its path or remove it.
- Starts one `pi --mode rpc` child for the open chat, resumes existing session files, and creates a new pi session on the first prompt.
- Streams assistant text, thinking, tool calls, and tool output.
- Collapses a finished turn's thinking and tool details automatically. Press the collapsed row to inspect them again.
- Exposes the installed pi model catalog from the composer.

Projects are stored by the nsh app under its own app storage. Removing a project from the sidebar does not delete pi session files.

## Layout

- `App.tsx` — app shell, sidebar, chat timeline, composer, dialogs
- `pi.ts` — pi RPC client, session scanning, model catalog
- `icons.tsx` — small monochrome line icons drawn with nsh's canvas
- `ui.tsx` — theme tokens and shared primitives
- `theme.json` — grayscale light/dark palette

The app asks for read/write access under the home folder because pi runs with the selected project as its working directory. Process execution is limited to the login shell and `osascript` (the folder chooser).
