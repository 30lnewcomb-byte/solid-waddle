# Solid-waddle persistence and shutdown behavior

Solid-waddle is currently a Node.js web app with a Docker-managed remote Chrome service. It is **not yet a complete virtual machine with its own virtual disk or operating-system image**. This document describes what currently persists and what the future VM must preserve.

## Current persistence

- The browser's Chrome profile is stored in the named Docker volume `chrome-config` declared in `compose.yaml`.
- Stopping or recreating the browser container does not normally remove that named volume. Do not use `docker compose down --volumes` / `docker compose down -v` unless intentionally deleting browser profile data.
- VM memory records are written to `.solid-waddle-memory.json` in the data directory.
- Browser page state is written to `.sideview-browser-state.json`.
- Both JSON state files are intentionally excluded from Git so private user data is not committed.

## Choosing durable storage

Set `SOLID_WADDLE_DATA_DIR` to a persistent directory before starting the Node server. The memory JSON file will be stored there. Keep this directory outside disposable containers and application installation folders where possible, back it up, and restrict access to the user running Solid-waddle.

Example for a local Windows PowerShell session:

```powershell
$env:SOLID_WADDLE_DATA_DIR = "$env:LOCALAPPDATA\SolidWaddle\Data"
npm start
```

That environment setting applies to the current PowerShell session. Set it in the launcher's environment as well when creating a desktop installer.

## Important limits

- A normal Codespaces stop/start generally retains the workspace, but deleting a Codespace can delete its workspace data. Git-ignored files are not backed up in the repository.
- Persistent memory storage is not a substitute for backups.
- The current code does not yet implement a bootable VM or a persistent VM virtual disk. The future VM design must store its disk image and configuration in durable user-controlled storage and must never automatically delete them on normal shutdown.
- Do not claim persistence is tested until the app is run, stopped, restarted, and its data is checked.
