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
  upstream releases never replace it. It is ad-hoc signed and not notarized.
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

- Right-click menu (`electron/main/context-menu.ts`): Copy for selected text;
  Cut/Copy/Paste/Select All and spelling suggestions in text fields; Copy Link
  for web links; Copy Image, Copy Image Address and Save Image As. An image
  under a dialog or backdrop gets no image items. Components that call
  `preventDefault()` on `contextmenu` (DM list, DM messages, like button) keep
  their own menu. In-app links are mostly `SecondaryPageLink` `<span>`s with no
  `href`, so they get no Copy Link; an `<a>` to the app's own origin would be
  copied as `https://jumble.social/...`.

### Tests

- Unit: `npm test`. CI also runs `npm run lint` and `npm run build`.
- Real app: `ELECTRON=true npx vite build --config vite.electron.config.ts`, then
  `node scripts/fork/e2e-context-menu.mjs`. For the built app, set
  `JUMBLE_E2E_APP="$PWD/release/chad-<version>/mac-arm64/Jumble Chad.app/Contents/MacOS/Jumble Chad"`;
  it then runs with a temporary `--user-data-dir` and checks that auto-update is
  off. A packaged run creates the "Jumble Chad Safe Storage" Keychain item: delete
  it after a test if Chad has not opened the app yet. It drives the dev app with
  Playwright's `_electron`, keeps the window invisible and click-through,
  replaces `shell.openExternal` so no browser opens, and puts the clipboard back.
  `npm run build` (web) overwrites `dist/`, so rebuild the Electron renderer
  before a real-app run.
- On macOS a role item (`copy`, `paste` ...) sends its action to the key window,
  like Edit > Copy; `MenuItem.click()` from a script does nothing for it. The
  test window is not key (making it key would take the user's keyboard focus),
  so tests check that the role is present and enabled, and check the copy with
  `webContents.copy()`. One check opens the real native menu for 300 ms.
