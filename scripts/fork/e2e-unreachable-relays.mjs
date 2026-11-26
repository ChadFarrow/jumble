// Real-app test: reads to a relay that gives no answer end at once on the next
// start (src/lib/unreachable-relays.ts). Fork-only script.
//
//   ELECTRON=true npx vite build --config vite.electron.config.ts
//   node scripts/fork/e2e-unreachable-relays.mjs
//
// Needs a relay that gives no answer from this machine: JUMBLE_E2E_DEAD_RELAY,
// default wss://nos.lol/ (it drops Chad's home network, measured 2026-11-26).
// A logged-out start sends no REQ (welcome screen), so the test logs in
// read-only with an npub (no key: it cannot publish). On a cold start the app
// fetches that npub's relay list and profile from BIG_RELAY_URLS, which hold
// nos.lol. Reads only: REQs, never EVENTs or COUNTs. It prints every relay it
// read, and logs out at the end.
//
// Three launches of the dev app (jumble-dev data folder), each with a cleared
// IndexedDB. Launch 1 starts with no unreachable-relays.json and waits until
// the app marks the dead relay. Launch 2 checks that every REQ to it gets EOSE
// at once and is not closed (it stays registered, to attach if the relay
// answers again). Launch 3 is the next morning: the test ages that mark by 6 h
// and also seeds an aged mark on a relay that answers (JUMBLE_E2E_LIVE_RELAY).
// The dead relay's re-check must fail in the background with no wait; the live
// relay's re-check must clear its mark, and its skipped REQs must attach and
// receive events. The test deletes the file at the end.
//
// Env:
//   JUMBLE_E2E_DEAD_RELAY  the relay that gives no answer (default wss://nos.lol/)
//   JUMBLE_E2E_LIVE_RELAY  a read relay of the npub that answers and holds
//                          events for it (default wss://chadf.nostr1.com/)
//   JUMBLE_E2E_NPUB        the account (default: ChadF); the test also times
//                          its notification REQ, which reads its own relays
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nip19 } from 'nostr-tools'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(REPO, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const DEAD = process.env.JUMBLE_E2E_DEAD_RELAY ?? 'wss://nos.lol/'
const LIVE = process.env.JUMBLE_E2E_LIVE_RELAY ?? 'wss://chadf.nostr1.com/'
const NPUB =
  process.env.JUMBLE_E2E_NPUB ?? 'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7'
const PK = nip19.decode(NPUB).data
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'jumble-dev')
const STORE = path.join(USER_DATA, 'unreachable-relays.json')
const MARK_WAIT_MS = 45_000
const WATCH_MS = 12_000
const MORNING_WATCH_MS = 15_000
const HOURS_6 = 6 * 60 * 60 * 1000

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
  )
}

const readStore = () => {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return null
  }
}

/** Starts the dev app with a cleared cold start; returns the reload time. */
async function launch(label) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [
      REPO,
      '--mute-audio',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling'
    ],
    cwd: REPO,
    env: { ...process.env, VITE_DEV_SERVER_URL: '' }
  })
  const logs = []
  const page = await app.firstWindow()
  page.on('pageerror', (e) => logs.push(`[${label} pageerror] ${e.message}`.slice(0, 300)))
  await page.waitForLoadState('domcontentloaded')

  const userData = await app.evaluate(
    async ({ app: electronApp, BrowserWindow, ipcMain, shell, session }, { dead, live, pk }) => {
      shell.openExternal = async () => {}
      const w = BrowserWindow.getAllWindows()[0]
      w.setOpacity(0)
      w.setIgnoreMouseEvents(true)
      // IndexedDB only: the app backs localStorage up to main and would
      // restore that backup over a clear made from here. The login below
      // overwrites the account keys.
      await session.defaultSession.clearStorageData({ storages: ['indexdb'] })

      const subs = (globalThis.__e2eSubs = new Map())
      const urls = (globalThis.__e2eUrls = new Set())
      const subscribe = ipcMain._invokeHandlers.get('relay:subscribe')
      ipcMain._invokeHandlers.set('relay:subscribe', (e, subId, url, filters) => {
        urls.add(url)
        const notification = filters.some((f) => f['#p']?.includes(pk))
        if (url === dead || url === live || notification) {
          subs.set(subId, {
            url,
            notification,
            start: Date.now(),
            eose: null,
            close: null,
            eventsAfterEose: 0
          })
        }
        return subscribe(e, subId, url, filters)
      })
      const send = w.webContents.send.bind(w.webContents)
      w.webContents.send = (ch, p) => {
        const s = p && typeof p === 'object' ? subs.get(p.subId) : undefined
        if (s && ch === 'relay:sub:eose') s.eose ??= Date.now()
        if (s && ch === 'relay:sub:close') s.close ??= p.reason
        if (s && ch === 'relay:sub:event' && s.eose !== null) s.eventsAfterEose++
        return send(ch, p)
      }
      return electronApp.getPath('userData')
    },
    { dead: DEAD, live: LIVE, pk: PK }
  )
  if (userData !== USER_DATA) throw new Error(`unexpected userData ${userData}`)

  {
    await page.evaluate(
      ({ pk, npub }) => {
        localStorage.setItem('accounts', JSON.stringify([{ pubkey: pk, signerType: 'npub', npub }]))
        localStorage.setItem('currentAccount', JSON.stringify({ pubkey: pk, signerType: 'npub' }))
      },
      { pk: PK, npub: NPUB }
    )
    // The app backs localStorage up to main 50 ms after a change and restores
    // a newer backup on reload: let it save the login first.
    await page.waitForTimeout(500)
  }
  const t0 = Date.now()
  await page.reload()
  const subs = () =>
    app
      .evaluate(() => [...globalThis.__e2eSubs.values()])
      .then((all) => all.filter((s) => s.start >= t0))
  return { app, page, logs, t0, subs }
}

async function close(run, label) {
  const urls = await run.app.evaluate(() => [...globalThis.__e2eUrls]).catch(() => [])
  console.log(`  ${label} read from: ${urls.sort().join(' ')}`)
  await run.page
    .evaluate(() => {
      localStorage.removeItem('accounts')
      localStorage.removeItem('currentAccount')
    })
    .catch(() => {})
  await run.page.waitForTimeout(500)
  await run.app.close()
}

const logs = []
try {
  rmSync(STORE, { force: true })

  // Launch 1: the app meets the dead relay and marks it.
  const first = await launch('launch 1')
  let markedAt = null
  while (Date.now() - first.t0 < MARK_WAIT_MS) {
    if (readStore()?.[DEAD]) {
      markedAt = Date.now()
      break
    }
    await first.page.waitForTimeout(250)
  }
  const firstDead = (await first.subs()).filter((s) => s.url === DEAD)
  console.log(
    `  launch 1: ${firstDead.length} REQs to ${DEAD}; slowest ended ${Math.max(0, ...firstDead.map((s) => (s.eose ?? Date.now()) - s.start))} ms after its start`
  )
  record('launch 1: the app marks the relay that gives no answer', markedAt !== null, {
    msAfterReload: markedAt === null ? null : markedAt - first.t0,
    marked: Object.keys(readStore() ?? {})
  })
  logs.push(...first.logs)
  await close(first, 'launch 1')

  // Launch 2: every read to it gets EOSE at once.
  const second = await launch('launch 2')
  await second.page.waitForTimeout(WATCH_MS)
  const all = await second.subs()
  const dead = all.filter((s) => s.url === DEAD)
  const waits = dead.map((s) => (s.eose === null ? null : s.eose - s.start))
  record('launch 2: the app still sends reads to that relay', dead.length > 0, {
    count: dead.length
  })
  record(
    'launch 2: every read to it gets EOSE at once (< 200 ms)',
    dead.length > 0 && waits.every((w) => w !== null && w < 200),
    { maxMs: waits.includes(null) ? 'not ended' : Math.max(0, ...waits) }
  )
  record(
    'launch 2: none of them is closed (they stay registered)',
    dead.length > 0 && dead.every((s) => s.close === null),
    { closeReasons: [...new Set(dead.map((s) => s.close).filter(Boolean))] }
  )
  const notif = all.filter((s) => s.notification)
  const notifStart = notif.length ? Math.min(...notif.map((s) => s.start)) - second.t0 : null
  record(
    'launch 2: the notification REQ starts < 3 s after the reload',
    notifStart !== null && notifStart < 3000,
    { msAfterReload: notifStart }
  )
  record('the file still names the relay', !!readStore()?.[DEAD])
  logs.push(...second.logs)
  await close(second, 'launch 2')

  // Launch 3, the next morning: both marks are 6 h old, so the first read to
  // each starts its re-check.
  const aged = Date.now() - HOURS_6
  writeFileSync(
    STORE,
    JSON.stringify({
      [DEAD]: { markedAt: aged - HOURS_6, checkedAt: aged },
      [LIVE]: { markedAt: aged - HOURS_6, checkedAt: aged }
    })
  )
  const third = await launch('launch 3')
  let liveClearedAt = null
  while (Date.now() - third.t0 < MORNING_WATCH_MS) {
    if (liveClearedAt === null && readStore() && !readStore()[LIVE]) liveClearedAt = Date.now()
    await third.page.waitForTimeout(250)
  }
  const morning = await third.subs()
  const deadMorning = morning.filter((s) => s.url === DEAD)
  const deadWaits = deadMorning.map((s) => (s.eose === null ? null : s.eose - s.start))
  record(
    'launch 3: every read to the dead relay gets EOSE at once (< 200 ms)',
    deadMorning.length > 0 && deadWaits.every((w) => w !== null && w < 200),
    {
      count: deadMorning.length,
      maxMs: deadWaits.includes(null) ? 'not ended' : Math.max(0, ...deadWaits)
    }
  )
  record(
    'launch 3: none of them is closed',
    deadMorning.every((s) => s.close === null),
    { closeReasons: [...new Set(deadMorning.map((s) => s.close).filter(Boolean))] }
  )
  const deadRecord = readStore()?.[DEAD]
  record(
    "launch 3: the dead relay's re-check ran and kept the mark",
    !!deadRecord && deadRecord.checkedAt >= third.t0,
    { checkedMsAfterReload: deadRecord ? deadRecord.checkedAt - third.t0 : null }
  )
  record('launch 3: the relay that answers loses its mark', liveClearedAt !== null, {
    msAfterReload: liveClearedAt === null ? null : liveClearedAt - third.t0
  })
  const liveMorning = morning.filter((s) => s.url === LIVE)
  const attached = liveMorning.filter(
    (s) => s.eose !== null && s.eose - s.start < 200 && s.eventsAfterEose > 0
  )
  record('launch 3: a skipped REQ to it attaches and receives events', attached.length > 0, {
    reqs: liveMorning.length,
    skippedThenAttached: attached.length,
    notification: attached.some((s) => s.notification)
  })
  record(
    'launch 3: no REQ to it is closed',
    liveMorning.every((s) => s.close === null),
    { closeReasons: [...new Set(liveMorning.map((s) => s.close).filter(Boolean))] }
  )
  const morningNotif = morning.filter((s) => s.notification)
  const morningStart = morningNotif.length
    ? Math.min(...morningNotif.map((s) => s.start)) - third.t0
    : null
  record(
    'launch 3: the notification REQ starts < 3 s after the reload',
    morningStart !== null && morningStart < 3000,
    { msAfterReload: morningStart }
  )
  logs.push(...third.logs)
  await close(third, 'launch 3')
  record('no page errors', logs.length === 0, logs.length ? logs : undefined)
} finally {
  rmSync(STORE, { force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(existsSync(STORE) ? 'store file left behind' : 'store file removed')
process.exit(failed.length ? 1 : 0)
