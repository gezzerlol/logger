# Climate Logger – phone / browser app

A single static web app (no build step, no server code): `index.html`, `core.js`, `app.js`, `sw.js`, `manifest.webmanifest`.
It talks to the logger with **Web Bluetooth**.

## Why a web app
Swift apps cannot be built on Windows. This runs on iPhone in the **Bluefy** browser (Safari does not support Web Bluetooth),
and also in Chrome/Edge on Windows, Android and macOS.

## Hosting (needs HTTPS)
Web Bluetooth only works on secure origins. Easiest free option: **GitHub Pages**
1. Create a repository, upload the five files at the top level.
2. Settings → Pages → deploy from the `main` branch.
3. Open `https://<you>.github.io/<repo>/` in Bluefy (or Chrome on a PC) and bookmark it.
For quick tests on a PC: `python -m http.server` in this folder and open `http://localhost:8000` in Chrome.

## Use
* **Add logger / Sync**: wake the logger (button or reset), tap *Add logger* the first time and pick it. Next time, *Sync*
  reconnects directly if the browser remembers the permission (Chrome does; Bluefy support is unverified – if not, use *Add logger* again).
* Only new records are downloaded and merged into the on-phone database; every logger you add appears as a chip at the top.
* Charts: 1 h / 6 h / 24 h / 7 d / 30 d / All, arrows to move through time, touch a chart to read exact values.
* **Logger settings**: name, interval, BLE window, temperature offset, low-battery cut-off, battery calibration, guerrilla mode, erase log.
* **Tools**: CSV export, **Back up data** (gzip JSON, shared via the iOS share sheet), **Restore backup**.

## Data retention
Data is stored in the browser's IndexedDB and persistent storage is requested. Browsers can still evict site data
(iOS can clear it for sites not used for a while), so: the logger itself keeps ~266 days at 1 min and a re-sync restores
the recent past; use *Back up data* regularly for anything older. The app nudges you if the last backup is over 14 days old.

## Time
Same scheme as the PC client: every sync stores (phone time, logger uptime) for the logger's current session; with two or more
syncs at least 10 min apart a clock-drift factor is fitted. Sessions that ended before ever being synced are placed just before
the next known session and marked "estimated".

## Not done yet
* Manual map pins for logger locations (planned after the core app).
* Guerrilla mode: a web page cannot keep a standing connection request, so open the app near the logger and tap Sync;
  the logger answers within its wake period (default 10 s).
