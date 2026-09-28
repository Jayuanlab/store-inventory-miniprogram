# Repository setup

This repository contains application source code, not a backup of the shop's accounts.

Local database files, backups, inventory spreadsheets, reports containing real inventory values, environment secrets, and developer-specific settings are intentionally excluded.

Before starting a fresh clone, provision a suitable private seed JSON file at `server/data/store.json` (or set `STORE_SEED_PATH`), or restore a verified SQLite backup to the configured database path. Do not commit production data. See README.md for the backup and restore procedure.

The checked-in WeChat AppID is a development configuration. Configure your own authorized AppID and backend credentials before deployment; keep AppSecret on the backend only.
