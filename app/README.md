# Gofile Manager (desktop)

A Tauri desktop front-end for the Gofile API, built on the `gofile-api` crate in
the repo root. It's a real management UI — browse your folder tree, upload
(drag-and-drop or picker), rename, move, copy, delete, toggle public/private,
set descriptions/tags/passwords/expiry, create folders, search recursively,
generate direct links, and reset your API token.

## Architecture

```
app/
├── src/                 vanilla HTML/CSS/JS frontend (no build step)
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── src-tauri/           Rust backend
    ├── src/lib.rs       #[tauri::command]s wrapping the gofile-api crate
    ├── src/main.rs
    ├── tauri.conf.json
    ├── capabilities/    window permissions (dialog, opener)
    └── icons/
```

The backend holds the authenticated `Gofile` client in managed state; the
frontend talks to it over Tauri's `invoke`. The token is stored locally in the
OS app-config dir (`settings.json`) when "Remember token" is checked.

## Run it

No Tauri CLI or `npm install` needed — the frontend is static, so a plain cargo
run launches the app:

```powershell
cargo run --manifest-path app/src-tauri/Cargo.toml
```

First launch: paste your API token (from <https://gofile.io/myprofile>) and
click **Connect**. It auto-loads your root folder.

### Optional: nicer dev/build via the Tauri CLI

```powershell
cargo install tauri-cli --version "^2"
cargo tauri dev      # run from app/src-tauri, with devtools
cargo tauri build    # produce an installer (MSI/NSIS) under target/release/bundle
```

## Notes

- **Move/Copy** asks for a destination folder ID. Use the **Copy ID** action on
  any folder (row ⋮ menu) or the **Copy ID** button in the top bar to grab one.
- **Download / View** opens the item's public page in your browser. Gofile has
  no authenticated file-bytes endpoint, so direct-to-disk download isn't wired.
- Uploads run concurrently (default 4 at a time) to keep a fast link busy.
- Requires WebView2, which ships with Windows 11.
