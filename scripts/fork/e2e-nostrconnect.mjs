// Real-app test: log in with a remote signer, by the nostrconnect:// QR code
// and by a bunker:// link (the "Remote signer" page). Fork-only script.
//
//   ELECTRON=true npx vite build --config vite.electron.config.ts
//   node scripts/fork/e2e-nostrconnect.mjs
//
// The script plays the remote signer with a new throwaway key. For the QR, it
// reads the URI from the page and sends the encrypted connect answer (the URI's
// secret) to the URI's relays. For bunker://, it pastes its own link and
// answers the app's connect. It answers get_public_key, switch_relays and
// ping, and refuses sign_event, so the app can publish nothing for the
// throwaway account. It sends only kind 24133 events (ephemeral, encrypted).
//
// "Amber" scenarios: a second signer with the same key answers every request
// with "no permission" at once, and the real answer comes 300 ms later. This is
// Chad's setup (Amber and Clave hold the same key, 2026-11-26): the app must
// ignore the refusal (src/lib/nip46-unknown-refusal.ts) and log in.
//
// The dev app uses the jumble-dev data folder. The test logs out before each
// scenario and at the end.
//
// Env:
//   JUMBLE_E2E_SCAN_DELAY_MS  QR scenarios: wait between the QR showing and the
//                             answer (default 3000: a person needs time to scan)
//   JUMBLE_E2E_SCENARIOS      comma list of scenario names (default: all)
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(REPO, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')
const { generateSecretKey, getPublicKey, finalizeEvent, nip44, SimplePool } = require('nostr-tools')

const SCAN_DELAY_MS = Number(process.env.JUMBLE_E2E_SCAN_DELAY_MS ?? 3000)
const BUNKER_RELAY = 'wss://relay.powr.build/'
const SCENARIOS = [
  { name: 'qr', flow: 'qr', amber: false },
  { name: 'qr-amber', flow: 'qr', amber: true },
  { name: 'qr-amber-switch', flow: 'qr', amber: true, switchRelays: [BUNKER_RELAY] },
  // Clave answers follow-up requests from a loop with a 2 s sleep: slow answers.
  { name: 'qr-amber-slow', flow: 'qr', amber: true, realDelayMs: 3000 },
  {
    name: 'qr-amber-slow-switch',
    flow: 'qr',
    amber: true,
    realDelayMs: 3000,
    switchRelays: [BUNKER_RELAY]
  },
  { name: 'bunker-amber', flow: 'bunker', amber: true }
].filter(
  (s) =>
    !process.env.JUMBLE_E2E_SCENARIOS ||
    process.env.JUMBLE_E2E_SCENARIOS.split(',').includes(s.name)
)

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
  )
}
const T0 = Date.now()
const ts = () => `${String(Date.now() - T0).padStart(6)} ms`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A remote signer with a throwaway key. With `amber`, a second signer of the
 * same key refuses every request first. */
async function startSigner({ relays, amber, switchRelays, bunkerSecret, realDelayMs }) {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  const pool = new SimplePool()
  const keys = new Map()
  const ck = (other) => {
    if (!keys.has(other)) keys.set(other, nip44.getConversationKey(sk, other))
    return keys.get(other)
  }
  const requests = []
  let answerRelays = relays
  const send = (to, payload, onRelays) =>
    Promise.allSettled(
      pool.publish(
        onRelays,
        finalizeEvent(
          {
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', to]],
            content: nip44.encrypt(JSON.stringify(payload), ck(to))
          },
          sk
        )
      )
    )
  const onRequest = async (ev) => {
    let req
    try {
      req = JSON.parse(nip44.decrypt(ev.content, ck(ev.pubkey)))
    } catch {
      return
    }
    if (requests.some((r) => r.id === req.id)) return
    requests.push({ at: Date.now(), id: req.id, method: req.method })
    const onRelays = answerRelays
    if (amber) void send(ev.pubkey, { id: req.id, result: '', error: 'no permission' }, onRelays)
    let payload
    if (req.method === 'get_public_key') payload = { id: req.id, result: pk }
    else if (req.method === 'switch_relays')
      payload = { id: req.id, result: JSON.stringify(switchRelays ?? null) }
    else if (req.method === 'ping') payload = { id: req.id, result: 'pong' }
    else if (req.method === 'connect')
      payload =
        bunkerSecret && req.params?.[1] !== bunkerSecret
          ? { id: req.id, result: '', error: 'wrong secret' }
          : { id: req.id, result: 'ack' }
    else payload = { id: req.id, result: '', error: 'refused by the test signer' }
    await sleep(realDelayMs ?? (amber ? 300 : 0))
    await send(ev.pubkey, payload, onRelays)
    if (req.method === 'switch_relays' && switchRelays) answerRelays = switchRelays
  }
  const listenOn = [...new Set([...relays, ...(switchRelays ?? [])])]
  await new Promise((resolve) => {
    pool.subscribe(
      listenOn,
      { kinds: [24133], '#p': [pk], since: Math.floor(Date.now() / 1000) - 5 },
      { onevent: onRequest, oneose: resolve }
    )
    setTimeout(resolve, 8000)
  })
  return { pk, requests, send, close: () => pool.destroy() }
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
const logOut = async () => {
  await page.evaluate(() => {
    localStorage.setItem('accounts', '[]')
    localStorage.removeItem('currentAccount')
  })
  // The app backs localStorage up to main 50 ms after a change and restores
  // a newer backup on reload: let it save first.
  await page.waitForTimeout(500)
}
const openRemoteSignerPage = async () => {
  await page.reload()
  await page.waitForSelector('[title="Login"]', { timeout: 30000 })
  await page.evaluate(() => document.querySelector('[title="Login"]').click())
  await page.waitForFunction(
    () => [...document.querySelectorAll('*')].some((el) => el.textContent === 'Remote signer'),
    null,
    { timeout: 10000 }
  )
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.textContent === 'Remote signer')
    ;(el.closest('button,[role="button"],div[class*="cursor"]') ?? el).click()
  })
  const a = await page.waitForSelector('a[href^="nostrconnect://"]', { timeout: 10000 })
  return a.getAttribute('href')
}
/** Logged in as `pk`: the dialog is gone and the account is current. */
const waitForLogin = async (pk, ms) => {
  const start = Date.now()
  let state
  while (Date.now() - start < ms) {
    state = await page.evaluate(() => ({
      dialog: !!document.querySelector('a[href^="nostrconnect://"]'),
      current: localStorage.getItem('currentAccount'),
      errors: [...document.querySelectorAll('.text-destructive, [class*="text-red"]')]
        .map((e) => e.textContent.trim())
        .filter(Boolean)
    }))
    if (!state.dialog && state.current?.includes(pk)) return { ok: true, ms: Date.now() - start }
    await page.waitForTimeout(200)
  }
  return { ok: false, errors: state?.errors }
}

try {
  page = await app.firstWindow()
  page.on('pageerror', (e) => logs.push(`${ts()} [pageerror] ${e.message}`.slice(0, 300)))
  page.on('console', (m) => {
    const text = m.text()
    if (/nip46|NostrConnection|bunker|signer/i.test(text))
      logs.push(`${ts()} [console.${m.type()}] ${text}`.slice(0, 300))
  })
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow, shell }) => {
    shell.openExternal = async () => {}
    const w = BrowserWindow.getAllWindows()[0]
    w.setOpacity(0)
    w.setIgnoreMouseEvents(true)
  })

  for (const s of SCENARIOS) {
    console.log(`${ts()} scenario ${s.name}`)
    await logOut()
    const connectionString = await openRemoteSignerPage()
    let signer
    try {
      if (s.flow === 'qr') {
        const uri = new URL(connectionString)
        const clientPk = uri.hostname || uri.pathname.replace(/^\/+/, '')
        const relays = uri.searchParams.getAll('relay')
        signer = await startSigner({
          relays,
          amber: s.amber,
          switchRelays: s.switchRelays,
          realDelayMs: s.realDelayMs
        })
        await sleep(SCAN_DELAY_MS)
        await signer.send(
          clientPk,
          { id: Math.random().toString(36).slice(2), result: uri.searchParams.get('secret') },
          relays
        )
      } else {
        const secret = Math.random().toString(36).slice(2)
        signer = await startSigner({ relays: [BUNKER_RELAY], amber: s.amber, bunkerSecret: secret })
        const link = `bunker://${signer.pk}?relay=${encodeURIComponent(BUNKER_RELAY)}&secret=${secret}`
        const typed = await page.evaluate((value) => {
          const input = document.querySelector('input[placeholder^="bunker://"]')
          if (!input) return false
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
            input,
            value
          )
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }, link)
        if (!typed) throw new Error('no bunker:// input')
        await page.waitForTimeout(200)
        const clicked = await page.evaluate(() => {
          // The dialog's Login button, not the sidebar's.
          const dialog = document.querySelector('#bunker-input')?.closest('[role="dialog"]')
          const b = [...(dialog ?? document).querySelectorAll('button')].find(
            (x) => x.textContent.trim() === 'Login' && !x.disabled
          )
          b?.click()
          return !!b
        })
        if (!clicked) throw new Error('no Login button')
      }
      const login = await waitForLogin(signer.pk, 40000)
      record(`${s.name}: logged in`, login.ok, {
        ms: login.ms,
        errors: login.errors,
        requests: signer.requests.map((r) => r.method)
      })
    } finally {
      signer?.close()
    }
  }
} finally {
  if (logs.length) console.log(logs.slice(-30).join('\n'))
  try {
    if (page) await logOut()
  } catch {}
  await app.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
