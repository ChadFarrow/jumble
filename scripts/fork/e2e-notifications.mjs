// Real-app test: notifications show without waiting for the slowest read relay
// (src/services/notification.service.ts). Fork-only script.
//
//   ELECTRON=true npx vite build --config vite.electron.config.ts
//   node scripts/fork/e2e-notifications.mjs
//
// Needs the internet: it reads the notifications of a public npub from that
// npub's own read relays. The account is a read-only npub login (no key, no
// signer), so it can never publish an event. Reads only: it sends REQs, never
// EVENTs, so it changes nothing on any relay.
//
// The dev app uses the jumble-dev data folder. The test clears its IndexedDB
// and localStorage first (a cold start), and logs out again at the end.
// In the main process, every message of one read relay's notification
// subscription is held back for JUMBLE_E2E_SLOW_MS, as a slow relay would be.
//
// Env:
//   JUMBLE_E2E_NPUB        the account (default: ChadF)
//   JUMBLE_E2E_SLOW_RELAY  the read relay to hold back (default wss://hist.nostr.land/)
//   JUMBLE_E2E_SLOW_MS     how long (default 8000)
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nip19 } from 'nostr-tools'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(REPO, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const NPUB =
  process.env.JUMBLE_E2E_NPUB ?? 'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7'
const PK = nip19.decode(NPUB).data
const SLOW_URL = process.env.JUMBLE_E2E_SLOW_RELAY ?? 'wss://hist.nostr.land/'
const SLOW_MS = Number(process.env.JUMBLE_E2E_SLOW_MS ?? 8000)
// Measured from the notification REQ: on a cold start the app first fetches
// the account's relay list, which can take long when a default relay times out.
const WATCH_MS = SLOW_MS + 6000

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
  )
}

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
let page
try {
  page = await app.firstWindow()
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`.slice(0, 300)))
  await page.waitForLoadState('domcontentloaded')

  await app.evaluate(
    async ({ BrowserWindow, ipcMain, shell, session }, { pk, slowUrl, slowMs }) => {
      shell.openExternal = async () => {}
      const w = BrowserWindow.getAllWindows()[0]
      w.setOpacity(0)
      w.setIgnoreMouseEvents(true)
      await session.defaultSession.clearStorageData({ storages: ['indexdb', 'localstorage'] })

      // Tag the notification subscriptions (the '#p' filter with zap receipts).
      const subs = (globalThis.__notifSubs = new Map())
      const subscribe = ipcMain._invokeHandlers.get('relay:subscribe')
      ipcMain._invokeHandlers.set('relay:subscribe', (e, subId, url, filters) => {
        if (filters.some((f) => f['#p']?.includes(pk) && f.kinds?.includes(9735))) {
          subs.set(subId, {
            url,
            start: Date.now(),
            first: null,
            eose: null,
            close: null,
            reason: null,
            events: 0,
            held: url === slowUrl ? [] : null,
            releasedAt: null
          })
        }
        return subscribe(e, subId, url, filters)
      })

      const send = w.webContents.send.bind(w.webContents)
      const deliver = (s, ch, p) => {
        const now = Date.now()
        if (ch === 'relay:sub:event') {
          s.events++
          s.first ??= now
        } else if (ch === 'relay:sub:eose') s.eose ??= now
        else if (ch === 'relay:sub:close') {
          s.close ??= now
          s.reason ??= p.reason
        }
        if (!w.isDestroyed()) send(ch, p)
      }
      w.webContents.send = (ch, p) => {
        const s = p && typeof p === 'object' ? subs.get(p.subId) : undefined
        if (!s || !String(ch).startsWith('relay:sub:')) return send(ch, p)
        if (!s.held) return deliver(s, ch, p)
        // The slow relay: keep its messages in order and release them together.
        if (s.held.length === 0) {
          setTimeout(
            () => {
              const held = s.held
              s.held = null
              s.releasedAt = Date.now()
              held.forEach(([c, m]) => deliver(s, c, m))
            },
            Math.max(0, s.start + slowMs - Date.now())
          )
        }
        s.held.push([ch, p])
      }
    },
    { pk: PK, slowUrl: SLOW_URL, slowMs: SLOW_MS }
  )

  // Read-only npub login, stored as the app stores it.
  await page.evaluate(
    ({ pk, npub }) => {
      localStorage.setItem('accounts', JSON.stringify([{ pubkey: pk, signerType: 'npub', npub }]))
      localStorage.setItem('currentAccount', JSON.stringify({ pubkey: pk, signerType: 'npub' }))
    },
    { pk: PK, npub: NPUB }
  )
  const t0 = Date.now()
  await page.reload()
  await page.waitForSelector('[title="Notifications"]', { timeout: 30000 })
  // A DOM click: Playwright's own click waits for animation frames, which an
  // invisible window may not give.
  await page.evaluate(() => document.querySelector('[title="Notifications"]').click())

  // The visible notification list: its top marker, then its own loading bar.
  const readList = () =>
    page.evaluate(() => {
      const marker = [...document.querySelectorAll('.scroll-mt-24\\.25')].find(
        (m) => m.offsetParent
      )
      const bar = marker?.nextElementSibling
      return {
        found: !!marker,
        loading:
          !!bar?.classList.contains('h-0.5') && !!bar.querySelector(':scope > .animate-shimmer'),
        groups: document.querySelectorAll('div.bg-border.sticky.z-20').length
      }
    })

  // Wait for the notification subscriptions; time everything from their REQ.
  const notifSubs = () =>
    app
      .evaluate(() => [...globalThis.__notifSubs.values()])
      .then((all) => all.filter((s) => s.start >= t0))
  let reqStart = null
  while (Date.now() - t0 < 30000) {
    const subs = await notifSubs()
    if (subs.length > 0) {
      reqStart = Math.min(...subs.map((s) => s.start))
      break
    }
    await page.waitForTimeout(50)
  }
  if (reqStart === null) throw new Error('no notification subscription within 30 s')
  console.log(`  notification REQ sent ${reqStart - t0} ms after the reload`)

  let firstShown = null
  let loadingAtFirst = null
  let loadingGone = null
  let last = null
  while (Date.now() - reqStart < WATCH_MS) {
    last = await readList()
    if (firstShown === null && last.groups > 0) {
      firstShown = Date.now()
      loadingAtFirst = last.loading
    }
    if (firstShown !== null && !last.loading) {
      loadingGone = Date.now()
      break
    }
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(500)
  last = await readList()

  const subs = await notifSubs()
  const rel = (t) => (t === null || t === undefined ? '-' : `${t - reqStart}`)
  for (const s of subs) {
    console.log(
      `  ${s.url.padEnd(32)} REQ ${rel(s.start)}  first ${rel(s.first)}  EOSE ${rel(s.eose)}  close ${rel(s.close)}  events ${s.events}${s.releasedAt ? '  (held back until ' + rel(s.releasedAt) + ')' : ''}${s.reason ? '  ' + s.reason : ''}`
    )
  }
  const slow = subs.find((s) => s.url === SLOW_URL)

  record('the held-back relay is a notification read relay', !!slow, {
    slowRelay: SLOW_URL,
    readRelays: subs.map((s) => s.url)
  })
  record(
    `the first notifications show before the slow relay answers (< ${SLOW_MS - 2000} ms)`,
    firstShown !== null && firstShown - reqStart < SLOW_MS - 2000,
    { msAfterReq: firstShown === null ? null : firstShown - reqStart }
  )
  record('the loading bar stays while the slow relay has not answered', loadingAtFirst === true)
  record(
    'the loading bar goes after the slow relay answers',
    loadingGone !== null && !!slow?.releasedAt && loadingGone >= slow.releasedAt,
    {
      goneMsAfterReq: loadingGone === null ? null : loadingGone - reqStart,
      releasedMsAfterReq: slow?.releasedAt ? slow.releasedAt - reqStart : null
    }
  )
  record('the list still shows notifications at the end', last.found && last.groups > 0, last)

  // Refresh (the list's refresh button): the client replays its in-memory
  // timeline as a partial result, and the slow relay is held back again.
  const before = (await notifSubs()).length
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.offsetParent && b.querySelector('svg.lucide-refresh-ccw')
    )
    btn?.click()
    return !!btn
  })
  record('the refresh button is there', clicked)
  let req2 = null
  const t1 = Date.now()
  while (clicked && Date.now() - t1 < 10000) {
    const subs2 = await notifSubs()
    if (subs2.length > before) {
      req2 = Math.min(...subs2.slice(before).map((s) => s.start))
      break
    }
    await page.waitForTimeout(50)
  }
  let shown2 = null
  let gone2 = null
  while (req2 !== null && Date.now() - req2 < WATCH_MS) {
    const st = await readList()
    if (shown2 === null && st.groups > 0) shown2 = Date.now()
    if (shown2 !== null && !st.loading) {
      gone2 = Date.now()
      break
    }
    await page.waitForTimeout(50)
  }
  record(
    `after a refresh, notifications show before the slow relay answers (< ${SLOW_MS - 2000} ms)`,
    req2 !== null && shown2 !== null && shown2 - req2 < SLOW_MS - 2000,
    { msAfterReq: req2 === null || shown2 === null ? null : shown2 - req2 }
  )
  last = await readList()
  record(
    'after a refresh, loading ends and the list shows notifications',
    gone2 !== null && last.groups > 0,
    {
      goneMsAfterReq: req2 === null || gone2 === null ? null : gone2 - req2,
      ...last
    }
  )
} catch (e) {
  record('test ran to the end', false, e.message.split('\n')[0])
} finally {
  await page
    ?.evaluate(() => {
      localStorage.removeItem('accounts')
      localStorage.removeItem('currentAccount')
    })
    .catch(() => {})
  await app.close().catch(() => {})
  record('no page errors', logs.length === 0, logs.length ? logs : undefined)
  const failed = results.filter((r) => !r.ok).length
  console.log(`DONE ${results.length - failed}/${results.length} passed`)
  process.exitCode = failed ? 1 : 0
}
