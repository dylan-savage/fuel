# Set up fuel on the Mac mini

This guide installs the fuel server as a launchd agent, serves it over HTTPS on the tailnet, and puts the app on the iPhone Home Screen. It assumes the repo is at `/Users/dylansavage/Desktop/Personal-AI/2026-10-28-fuel` and Node 22.22.3 is installed through nvm.

## Build

```sh
cd /Users/dylansavage/Desktop/Personal-AI/2026-10-28-fuel
npm ci
npm run build
```

`scripts/run.sh` pins `/Users/dylansavage/.nvm/versions/node/v22.22.3/bin/node`. If you move to another Node version, edit that path and run `npm rebuild`, because `better-sqlite3` is a native module built for one Node ABI.

## Install the launchd agent

```sh
cp scripts/com.dylansavage.fuel.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dylansavage.fuel.plist
```

The agent starts at login and restarts the server if it exits. To confirm the server is up, open `http://127.0.0.1:8787/healthz` on the mini. It answers `{"ok":true,"epoch":"…","rev":0}`. Logs go to `~/Library/Logs/fuel.log`, one JSON object per line.

The server reads these optional environment variables:

| Variable | Default |
|---|---|
| `FUEL_PORT` | `8787` |
| `FUEL_DATA_DIR` | `~/Library/Application Support/fuel` (holds `fuel.db`) |
| `FUEL_BACKUP_DIR` | `~/Library/Mobile Documents/com~apple~CloudDocs/fuel-backups` |
| `FUEL_BACKUP_KEEP` | `30` |
| `FUEL_STATIC_DIR` | `dist/client` in the repo |

`run.sh` loads `.env.local` from the repo and from the parent folder, where tokenstash writes keys. Phase 1 needs no keys.

## Deploy a new version

```sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.dylansavage.fuel
```

The phone picks up the new shell on its next launch and shows **A new version is ready. Tap to reload.**

## Serve it on the tailnet

Before the first run, do these steps by hand:

1. In the Tailscale admin console, open **DNS** and enable **HTTPS Certificates**.
2. Install Tailscale on the iPhone and sign in to the same tailnet.

Then serve the server over HTTPS. The `tailscale` CLI is not on `PATH` on the mini, so call the one inside the app bundle:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8787
```

The app is now at `https://dylans-mac-mini.tail82aa2c.ts.net`. The server binds `127.0.0.1` only, so `tailscale serve` is the only way in from the network.

## Add fuel to the Home Screen

1. On the iPhone, open `https://dylans-mac-mini.tail82aa2c.ts.net` in Safari.
2. Tap **Share**, then **Add to Home Screen**.
3. Open fuel from the Home Screen once while online, then close it and open it again. The second launch is the one the service worker controls.

## Check phase 1 on the phone

Phase 1 is done when these hold on the real device:

1. With airplane mode on, fuel opens from the Home Screen and shows today.
2. With airplane mode on, a quick add appears at once with **1 waiting**. After you turn airplane mode off and bring fuel to the foreground, the badge clears.
3. **Scan with camera** reads a barcode to 13 digits on screen. Note whether iOS asks for camera permission again on later launches.
4. If the camera fails in the Home Screen app, **Take a photo** reads the same barcode.

## Restore from a backup

Backups are `fuel-YYYY-MM-DD.db` files in `FUEL_BACKUP_DIR`, written once a day. To restore one:

```sh
launchctl bootout gui/$(id -u)/com.dylansavage.fuel
cd ~/Library/Application\ Support/fuel
rm -f fuel.db-wal fuel.db-shm
cp ~/Library/Mobile\ Documents/com~apple~CloudDocs/fuel-backups/fuel-2026-10-28.db fuel.db
sqlite3 fuel.db "UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'epoch'"
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dylansavage.fuel.plist
```

The new epoch tells each phone the server was restored. On its next sync the phone pushes every document it holds, so edits made after the backup come back. Entries deleted after the backup also come back, because the phone keeps no record of deletes.
