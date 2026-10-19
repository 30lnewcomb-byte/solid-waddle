#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker is not available in this Codespace."; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker is not running. Start the Solid Waddle browser service first."; exit 1; }

volume="$(docker volume ls -q --filter label=com.docker.compose.volume=chrome-config | head -n 1)"
if [[ -z "$volume" ]]; then
  echo "ERROR: Could not find Solid Waddle's chrome-config Docker volume. No backup was created."
  echo "Start the browser service and try again. Do not run 'docker compose down -v'."
  exit 1
fi

backup_dir="$ROOT/.solid-waddle-backups"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%d-%H%M%S-UTC)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/state"
data_dir="${SOLID_WADDLE_DATA_DIR:-$ROOT}"
if [[ "$data_dir" != /* ]]; then data_dir="$ROOT/$data_dir"; fi
for file in .sideview-browser-state.json .solid-waddle-tabs.json .solid-waddle-memory.json;
  if [[ -f "$data_dir/$file" ]]; then
    cp -p "$data_dir/$file" "$stage/state/$file"
  fi
done

echo "Backing up the Chrome profile volume ($volume)..."
docker run --rm -v "$volume:/source:ro" -v "$stage:/backup" alpine:3.20 \
  tar -czf /backup/chrome-config.tar.gz -C /source .

cat > "$stage/BACKUP-INFO.txt" <<EOF
Solid Waddle state backup
Created: $stamp
Repository: 30lnewcomb-byte/solid-waddle
Included:
- Chrome profile Docker volume archive (chrome-config.tar.gz)
- Saved browser page, open-tab session, and VM memory JSON files from the configured data directory when present (state/)
This is a recovery backup, not a bootable VM disk image.
Keep a copy outside this Codespace if you need protection against deleting the Codespace.
EOF

archive="$backup_dir/solid-waddle-backup-$stamp.tar.gz"
tar -czf "$archive" -C "$stage" .
echo
echo "Backup created:"
echo "$archive"
echo "Copy/download this archive outside the Codespace for protection if the Codespace is ever deleted."
