# CLAUDE.md

See [AGENTS.md](./AGENTS.md) for project instructions.

## This fork (ChadFarrow/jumble)

This repo is ChadFarrow's fork of `CodyTseng/jumble`, for his own build of the
desktop (Electron) app on macOS. Fork-only notes live here, not in `AGENTS.md`,
so upstream merges stay clean.

- **Remotes:** `origin` = `ChadFarrow/jumble`, `upstream` = `CodyTseng/jumble`.
  The default branch is `master`.
- **Never write to `CodyTseng/jumble`** (no issue, comment, PR or review) unless
  Chad asks for that exact write.
- **Name the fork in every `gh` write:** `gh pr create -R ChadFarrow/jumble --base master`.
  Without `-R`, gh can pick the parent repo.
- **Never push a tag.** `.github/workflows/release.yml` builds and publishes a
  release on a tag push. No release, zapstore entry or store build.
- **Chad's app is "Jumble Chad"** (`/Applications/Jumble Chad.app`), a separate
  app next to upstream's Jumble (Chad's choice, 2026-11-26). Build and install it
  with `./scripts/fork/build-mac.sh --install` (Chad must quit it first). Its
  config, `scripts/fork/electron-builder.chad.cjs`, sets appId
  `com.chadfarrow.jumble` and the name "Jumble Chad", so it has its own data
  folder (`~/Library/Application Support/Jumble Chad`) and Keychain item
  ("Jumble Chad Safe Storage"). It has no publish target, so the build has no
  `app-update.yml`, and `electron/main/update-config.ts` keeps the updater off:
  upstream releases never replace it. It is ad-hoc signed and not notarized. Its designated
  requirement is a `cdhash`, so each rebuild is a new app to the Keychain:
  on the first open after an install, macOS can ask for access to "Jumble Chad
  Safe Storage". Tell Chad to choose Always Allow (Deny leaves his saved login
  unreadable).
  Chad signs in to it himself (nsec with Jumble's password). Never touch
  upstream's `~/Library/Application Support/jumble` or its Keychain item.
- **Dev runs use `~/Library/Application Support/jumble-dev`** (`app.isPackaged === false`).
- **Start every Electron or Chrome run with `--mute-audio`.**
- **Electron 45 clipboard is async:** `clipboard.readText()`/`writeText()`/`write()`
  return Promises, and there is no `readImage()`/`writeImage()`.
- **Images ignore the mouse:** `src/components/Image` draws `<img>` with
  `pointer-events: none`, so Chromium's context-menu params never report them.
  `electron/main/context-menu.ts` finds the image under the pointer with a page
  script instead.

### Fork features

- App icon: a "C" in the Jumble "J" style (`scripts/fork/icon-chad.svg`, rendered
  to `scripts/fork/icon-chad.png`, 1024 px, with
  `qlmanage -t -s 1024 -o <dir> scripts/fork/icon-chad.svg`), set as `mac.icon` in
  `scripts/fork/electron-builder.chad.cjs`, so the Dock tells Jumble Chad from
  Jumble. Upstream's icon (`public/pwa-512x512.png`) is unchanged. The 16 and 32 px
  entries of the built `icon.icns` show a few yellow pixels after `iconutil`
  decoding; upstream's own release build has the same, so it comes from the tools.

- Right-click menu (`electron/main/context-menu.ts`): Copy for selected text;
  Cut/Copy/Paste/Select All and spelling suggestions in text fields; Copy Link
  for web links; Copy Image, Copy Image Address and Save Image As. An image
  under a dialog or backdrop gets no image items. Components that call
  `preventDefault()` on `contextmenu` (DM list, DM messages, like button) keep
  their own menu. In-app links are mostly `SecondaryPageLink` `<span>`s with no
  `href`, so they get no Copy Link; an `<a>` to the app's own origin would be
  copied as `https://jumble.social/...`.

- Notifications do not wait for the slowest read relay
  (`src/services/notification.service.ts`): each relay's events are merged into
  the list when that relay answers (EOSE). The loading bar and "load more" still
  wait for the last relay (or the 10 s EOSE timeout). Upstream drops these
  partial results. Each partial result is capped at 100 events and only new
  ids are added (on pull-to-refresh the client replays its whole timeline).
  When the last relay answers, upstream's no-gap rule still applies: shown rows
  older than the newest 100 can go, and load more brings them back in order.

### Tests

- Unit: `npm test`. CI also runs `npm run lint` and `npm run build`.
- Real app: `ELECTRON=true npx vite build --config vite.electron.config.ts`, then
  `node scripts/fork/e2e-context-menu.mjs`. For the built app, set
  `JUMBLE_E2E_APP="$PWD/release/chad-<version>/mac-arm64/Jumble Chad.app/Contents/MacOS/Jumble Chad"`;
  it then runs with a temporary `--user-data-dir` and checks that auto-update is
  off. A packaged run creates the "Jumble Chad Safe Storage" Keychain item. Delete
  it after a test only while `~/Library/Application Support/Jumble Chad` does
  not exist (Chad has not opened the app). Once it exists, the item holds his
  saved login: never delete it, and do not run packaged tests that could touch it. It drives the dev app with
  Playwright's `_electron`, keeps the window invisible and click-through,
  replaces `shell.openExternal` so no browser opens, and puts the clipboard back.
  `npm run build` (web) overwrites `dist/`, so rebuild the Electron renderer
  before a real-app run.
- Real app, notifications: `node scripts/fork/e2e-notifications.mjs` (renderer
  rebuilt first). It clears the jumble-dev IndexedDB and localStorage, logs in
  read-only with an npub (no key: it cannot publish; it sends REQs only), holds
  back one read relay's answer for 8 s in the main process and checks that the
  first notifications show before it. Env: `JUMBLE_E2E_NPUB`,
  `JUMBLE_E2E_SLOW_RELAY` (default `wss://hist.nostr.land/`, must be one of the
  npub's read relays), `JUMBLE_E2E_SLOW_MS` (default 8000). On a cold start the
  notification REQ comes about 10 s after the reload: the account's relay-list
  and profile requests go to `BIG_RELAY_URLS`, and the app waits for
  `wss://nos.lol/`, which does not answer from Chad's home network (measured
  2026-11-26), until the 10 s EOSE timeout. Never send COUNT to Chad's Haven (`podtards.com`): its COUNT handling
  has a known CPU loop.
- On macOS a role item (`copy`, `paste` ...) sends its action to the key window,
  like Edit > Copy; `MenuItem.click()` from a script does nothing for it. The
  test window is not key (making it key would take the user's keyboard focus),
  so tests check that the role is present and enabled, and check the copy with
  `webContents.copy()`. One check opens the real native menu for 300 ms.
