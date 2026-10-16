# Solid-waddle persistence and safe shutdown

Solid-waddle's current browser-based version already has persistence mechanisms. Preserve these as the desktop shell evolves; do not replace them with browser-only storage or automatically erase them on shutdown.

## Existing persistence that must be preserved

- **Chrome profile:** `compose.yaml` mounts the named Docker volume `chrome-config` at `/home/seluser/.config`. A normal container stop/recreation keeps this volume.
- **Last browser page:** `server.mjs` saves the last safe browser URL and title in `.sideview-browser-state.json` in the project workspace and attempts to restore the URL when Chrome starts.
- **VM memory:** the memory API stores records in `.solid-waddle-memory.json` in the configured data directory. By default that is the project workspace; setting `SOLID_WADDLE_DATA_DIR` moves this memory file to a different persistent directory.
- **Git safety:** browser state and memory files are excluded from Git so personal data is not committed.

## Safe shutdown rules

- Normal stop/start must not delete browser profile data, memory records, settings, or VM files.
- `npm run stop` runs `docker compose down`. Do not change it to `docker compose down -v`.
- Never use `docker compose down --volumes` / `docker compose down -v` as a routine stop or update operation. These commands remove named volumes and can erase the Chrome profile.
- Updates should preserve the existing data directory and Docker volume.
- Do not automatically delete VM data during app close, server shutdown, container recreation, or upgrade.

## Codespaces and future installed VM

Codespaces normally retains a workspace when it is stopped and restarted, but deleting the Codespace can delete workspace files. Git-ignored state files are not backed up in Git. If long-term durability beyond the workspace is required, configure `SOLID_WADDLE_DATA_DIR` to a durable location and back up the Chrome volume as appropriate.

Example for a local Windows PowerShell session:

```powershell
$env:SOLID_WADDLE_DATA_DIR = "$env:LOCALAPPDATA\SolidWaddle\Data"
npm start
```

That environment setting applies to the current PowerShell session. A desktop launcher should set it too.

The current project is a Node.js server with a Docker-managed remote Chrome service; it is not yet a complete bootable VM with a virtual disk. The future VM design must keep its disk image and configuration in durable user-controlled storage, and normal shutdown must behave like powering off a computer—not deleting the computer.
