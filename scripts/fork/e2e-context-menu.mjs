// Real-app test of the right-click menu (electron/main/context-menu.ts) in a
// dev (unpackaged) Electron run. Fork-only script.
//
//   ELECTRON=true npx vite build --config vite.electron.config.ts
//   node scripts/fork/e2e-context-menu.mjs
//
// Needs the internet: it reads a public profile from the default relays.
// Uses the jumble-dev data folder, never the installed app's data. No login,
// so it can never publish an event.
// Menu.prototype.popup is replaced in the main process, so no native menu
// blocks: the test records the items and clicks them itself.
// shell.openExternal is replaced, so a click never opens Chad's browser.
// Chad's clipboard is saved first and put back at the end.
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = mkdtempSync(path.join(os.tmpdir(), 'jumble-ctx-'))
const require = createRequire(path.join(REPO, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')
// A public profile with notes, links and images (ChadF).
const NPUB =
  process.env.JUMBLE_E2E_NPUB ?? 'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
  )
}

// JUMBLE_E2E_APP=<path to the packaged executable> tests a packaged build
// (for example "release/chad-<v>/mac-arm64/Jumble Chad.app/Contents/MacOS/Jumble Chad").
// It then runs with a temporary data folder, so the app's real data stays untouched.
const PACKAGED = process.env.JUMBLE_E2E_APP
const USER_DATA = PACKAGED
  ? realpathSync(mkdtempSync(path.join(os.tmpdir(), 'jumble-ctx-data-')))
  : null
const app = await _electron.launch({
  executablePath: PACKAGED ?? electronPath,
  args: [
    ...(PACKAGED ? [`--user-data-dir=${USER_DATA}`] : [REPO]),
    '--mute-audio',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling'
  ],
  cwd: REPO,
  env: { ...process.env, VITE_DEV_SERVER_URL: '' }
})

let clipboardSaved = false
const logs = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`.slice(0, 300)))
  app.process().stderr.on('data', (d) => logs.push(`[main-err] ${d}`.slice(0, 300)))
  await page.waitForLoadState('domcontentloaded')

  const setup = await app.evaluate(
    async ({ app: eapp, BrowserWindow, Menu, clipboard, session, ClipboardItem, shell }, out) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setOpacity(0)
      w.setIgnoreMouseEvents(true)
      globalThis.__menus = []
      globalThis.__opened = []
      shell.openExternal = async (u) => {
        globalThis.__opened.push(u)
      }
      globalThis.__nativePopup = Menu.prototype.popup
      Menu.prototype.popup = function () {
        globalThis.__lastMenu = this
        globalThis.__menus.push(
          this.items.map((i) => ({
            type: i.type,
            label: i.label,
            role: i.role,
            enabled: i.enabled
          }))
        )
      }
      session.defaultSession.on('will-download', (_e, item) => {
        item.setSavePath(out + '/saved-' + item.getFilename())
      })
      globalThis.__savedClipboard = []
      for (const item of await clipboard.read()) {
        const data = {}
        for (const t of item.types) {
          try {
            data[t] = await item.getType(t)
          } catch {}
        }
        if (Object.keys(data).length) globalThis.__savedClipboard.push(new ClipboardItem(data))
      }
      const edit = Menu.getApplicationMenu()
        ?.items.find((i) => i.role === 'editmenu' || i.label === 'Edit')
        ?.submenu?.items.map((i) => i.role)
      return {
        saved: globalThis.__savedClipboard.length,
        muted: eapp.commandLine.hasSwitch('mute-audio'),
        userData: eapp.getPath('userData'),
        editMenuRoles: edit ?? null
      }
    },
    OUT
  )
  clipboardSaved = true
  record('audio is muted', setup.muted)
  if (PACKAGED) {
    record(
      'packaged run uses the temporary data folder',
      setup.userData === USER_DATA,
      setup.userData
    )
    const update = await page.evaluate(() => window.electron?.update?.getState())
    record('packaged run: auto-update is off', update?.supported === false, update)
  } else {
    record(
      'dev run uses its own data folder',
      setup.userData.endsWith('jumble-dev'),
      setup.userData
    )
  }
  record(
    'app menu has Edit > Copy and Paste (keyboard Cmd+C/V)',
    setup.editMenuRoles?.includes('copy') && setup.editMenuRoles.includes('paste'),
    setup.editMenuRoles
  )

  const lastMenu = async () => app.evaluate(() => globalThis.__menus.at(-1) ?? null)
  const menuCount = async () => app.evaluate(() => globalThis.__menus.length)
  const clickItem = async (label) =>
    app.evaluate(({ BrowserWindow }, l) => {
      const w = BrowserWindow.getAllWindows()[0]
      const item = globalThis.__lastMenu.items.find((i) => i.label === l)
      if (!item) return false
      item.click(undefined, w, w.webContents)
      return true
    }, label)
  const clipText = async () => app.evaluate(({ clipboard }) => clipboard.readText())
  const clipHasImage = async () => app.evaluate(({ clipboard }) => clipboard.has('image/png'))
  const clearClip = async () => app.evaluate(({ clipboard }) => clipboard.clear())
  const labels = (m) => m?.map((i) => (i.type === 'separator' ? '-' : i.role || i.label))
  const roleEnabled = (m, role) => m?.find((i) => i.role === role)?.enabled
  const rightClick = async (p) => {
    const before = await menuCount()
    await page.mouse.click(p.x, p.y, { button: 'right' })
    for (let i = 0; i < 20 && (await menuCount()) === before; i++) await page.waitForTimeout(100)
    return (await menuCount()) > before ? lastMenu() : null
  }
  const go = async (url, index) => {
    await page.evaluate(
      ({ url, index }) => {
        const state = { index, url }
        history.pushState(state, '', url)
        dispatchEvent(new PopStateEvent('popstate', { state }))
      },
      { url, index }
    )
  }

  await page.waitForTimeout(4000)
  const t0 = Date.now()
  await go(`/users/${NPUB}`, 100)
  await page.waitForFunction(() => document.querySelectorAll('a[href^="http"]').length > 3, null, {
    timeout: 60000
  })
  console.log(`profile notes visible after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await page.waitForTimeout(3000)

  // 1. Selected text in a note -> Copy (native role, enabled).
  const selected = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const el = node.parentElement
      if (!el || el.closest('a, button, nav') || node.textContent.trim().length < 25) continue
      el.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      const start = node.textContent.search(/\S/)
      range.setStart(node, start)
      range.setEnd(node, start + 12)
      const r = range.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) continue
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      if (sel.toString().trim().length < 5) continue
      return {
        text: sel.toString(),
        where: el.tagName + '.' + String(el.className).slice(0, 40),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2
      }
    }
    return null
  })
  {
    const m = await rightClick(selected)
    record(
      'selected text: menu is only Copy, enabled',
      JSON.stringify(labels(m)) === '["copy"]' && roleEnabled(m, 'copy'),
      { text: selected.text, menu: labels(m) }
    )
    const stillSelected = await page.evaluate(() => window.getSelection().toString())
    record(
      'selection stays after the right-click (Copy copies it)',
      stillSelected === selected.text,
      stillSelected
    )
  }

  // 2. A web link -> Copy Link copies its address.
  const link = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href^="http"]')].find(
      (e) => e.offsetParent && e.getBoundingClientRect().width > 0 && !e.querySelector('img')
    )
    a.scrollIntoView({ block: 'center' })
    window.getSelection().removeAllRanges()
    const r = a.getBoundingClientRect()
    return { href: a.href, x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 }
  })
  {
    await page.waitForTimeout(300)
    await clearClip()
    const m = await rightClick(link)
    record('link: menu starts with Copy Link', labels(m)?.[0] === 'Copy Link', labels(m))
    await clickItem('Copy Link')
    await page.waitForTimeout(300)
    record('link: Copy Link copies the address', (await clipText()) === link.href, link.href)
  }

  // 3. Images (JPEG, PNG, WebP...) -> Copy Image puts a PNG on the clipboard.
  const images = await page.evaluate(() => {
    const seen = new Set()
    return [...document.querySelectorAll('img')]
      .filter((i) => i.naturalWidth > 150 && i.offsetParent && i.getBoundingClientRect().width > 60)
      .map((i, k) => {
        i.setAttribute('data-ctx-img', String(k))
        return { k, src: i.currentSrc || i.src, inLink: !!i.closest('a') }
      })
      .filter((i) => i.src.startsWith('http') && !seen.has(i.src) && seen.add(i.src))
      .slice(0, 5)
  })
  for (const img of images) {
    const p = await page.evaluate((k) => {
      const el = document.querySelector(`[data-ctx-img="${k}"]`)
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }, img.k)
    await page.waitForTimeout(400)
    await clearClip()
    const m = await rightClick(p)
    const l = labels(m) ?? []
    const short = img.src.split('/').pop().slice(0, 24)
    record(
      `image ${short}: menu has the image items`,
      l.includes('Copy Image') &&
        l.includes('Copy Image Address') &&
        l.includes('Save Image As…') &&
        (!img.inLink || l[0] === 'Copy Link'),
      l
    )
    if (!l.includes('Copy Image')) continue
    await clickItem('Copy Image')
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      await page.waitForTimeout(250)
      ok = await clipHasImage()
    }
    record(`image ${short}: Copy Image puts a PNG on the clipboard`, ok)
    await clickItem('Copy Image Address')
    await page.waitForTimeout(300)
    record(`image ${short}: Copy Image Address copies the src`, (await clipText()) === img.src)
  }
  {
    const p = await page.evaluate(() => {
      const el = document.querySelector('[data-ctx-img]')
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })
    await page.waitForTimeout(400)
    await rightClick(p)
    await clickItem('Save Image As…')
    let saved = []
    for (let i = 0; i < 40 && saved.length === 0; i++) {
      await page.waitForTimeout(250)
      saved = readdirSync(OUT).filter((f) => f.startsWith('saved-') && !f.endsWith('.crdownload'))
    }
    record('Save Image As saves the file', saved.length > 0, saved)
  }

  // 3b. WebP and GIF, which Electron's nativeImage cannot decode.
  for (const [name, src] of [
    ['webp', 'https://www.gstatic.com/webp/gallery/1.webp'],
    ['gif', 'https://i.nostr.build/Moe4.gif']
  ]) {
    const p = await page.evaluate(async (src) => {
      document.getElementById('ctx-test-img')?.remove()
      const wrap = document.createElement('div')
      wrap.id = 'ctx-test-img'
      wrap.style.cssText =
        'position:fixed;left:40px;top:40px;width:240px;height:180px;z-index:99999'
      const img = document.createElement('img')
      img.src = src
      img.style.cssText = 'pointer-events:none;width:100%;height:100%;object-fit:cover'
      wrap.appendChild(img)
      document.body.appendChild(wrap)
      await img.decode().catch(() => {})
      return { x: 160, y: 130, loaded: img.naturalWidth > 0 }
    }, src)
    await clearClip()
    const m = await rightClick(p)
    record(`${name}: menu has Copy Image`, labels(m)?.includes('Copy Image'), {
      loaded: p.loaded,
      menu: labels(m)
    })
    await clickItem('Copy Image')
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      await page.waitForTimeout(250)
      ok = await clipHasImage()
    }
    record(`${name}: Copy Image puts a PNG on the clipboard`, ok)
  }
  await page.evaluate(() => document.getElementById('ctx-test-img')?.remove())

  // 4. The image view (lightbox) of a note image that is not in a link.
  const zoomable = await page.evaluate(() => {
    const w = [...document.querySelectorAll('.cursor-zoom-in')].find(
      (e) =>
        e.offsetParent &&
        !e.closest('a') &&
        e.querySelector('img') &&
        e.getBoundingClientRect().width > 80
    )
    if (!w) return null
    w.scrollIntoView({ block: 'center' })
    const b = w.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  if (!zoomable) record('image view: no zoomable note image on this page (not tested)', true)
  else {
    await page.waitForTimeout(400)
    await page.mouse.click(zoomable.x, zoomable.y)
    await page.waitForTimeout(1500)
    const box = await page.evaluate(() => {
      const el =
        document.querySelector('.yarl__slide_current img') ??
        document.querySelector('.yarl__slide img')
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, src: el.currentSrc || el.src }
    })
    if (!box) record('image view opens', false)
    else {
      await clearClip()
      const m = await rightClick(box)
      record(
        'image view: right-click shows Copy Image',
        labels(m)?.includes('Copy Image'),
        labels(m)
      )
      await clickItem('Copy Image')
      let ok = false
      for (let i = 0; i < 40 && !ok; i++) {
        await page.waitForTimeout(250)
        ok = await clipHasImage()
      }
      record('image view: Copy Image puts a PNG on the clipboard', ok)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(800)
    }
  }

  // 5. The like button keeps its own behavior: no native menu.
  {
    const r = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[title="Like"]')].find((e) => e.offsetParent)
      b.scrollIntoView({ block: 'center' })
      const x = b.getBoundingClientRect()
      return { x: x.left + x.width / 2, y: x.top + x.height / 2 }
    })
    await page.waitForTimeout(400)
    record('like button: right-click shows no native menu', (await rightClick(r)) === null)
  }

  // 6. Empty space: no menu.
  {
    await page.evaluate(() => window.getSelection().removeAllRanges())
    const r = await page.evaluate(() => ({ x: window.innerWidth - 5, y: window.innerHeight - 5 }))
    record('empty space: right-click shows no menu', (await rightClick(r)) === null)
  }

  // 6b. An image under a dialog backdrop: no image items.
  {
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-ctx-img]')
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect()
      const backdrop = document.createElement('div')
      backdrop.id = 'ctx-backdrop'
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5)'
      document.body.appendChild(backdrop)
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })
    await page.waitForTimeout(300)
    const m = await rightClick(r)
    record('image under a backdrop: no image items', !labels(m)?.includes('Copy Image'), labels(m))
    await page.evaluate(() => document.getElementById('ctx-backdrop')?.remove())
  }

  // 6c. Zoomed page (View > Zoom In): the image under the pointer is still found.
  {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5)
    )
    await page.waitForTimeout(800)
    const r = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-ctx-img]')].find((e) => e.offsetParent)
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, src: el.currentSrc || el.src }
    })
    await page.waitForTimeout(400)
    const m = await rightClick(r)
    record(
      'zoom 150%: right-click on an image shows Copy Image',
      labels(m)?.includes('Copy Image'),
      labels(m)
    )
    if (labels(m)?.includes('Copy Image Address')) {
      await clickItem('Copy Image Address')
      await page.waitForTimeout(300)
      record('zoom 150%: it is the image under the pointer', (await clipText()) === r.src)
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
    )
    await page.waitForTimeout(500)
  }

  // 6d. The real native menu opens (shown for a moment, then closed), and the
  // native Copy action copies the selected text.
  {
    const sel = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const el = node.parentElement
        if (!el || el.closest('a, button, nav') || node.textContent.trim().length < 25) continue
        el.scrollIntoView({ block: 'center' })
        const range = document.createRange()
        const start = node.textContent.search(/\S/)
        range.setStart(node, start)
        range.setEnd(node, start + 12)
        const r = range.getBoundingClientRect()
        if (r.width < 5 || r.height < 5) continue
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(range)
        if (s.toString().trim().length < 5) continue
        return { text: s.toString(), x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return null
    })
    await app.evaluate(({ Menu }) => {
      globalThis.__nativeShown = false
      const recordOnly = Menu.prototype.popup
      Menu.prototype.popup = function (options) {
        this.once('menu-will-show', () => {
          globalThis.__nativeShown = true
          setTimeout(() => this.closePopup(), 300)
        })
        Menu.prototype.popup = recordOnly
        return globalThis.__nativePopup.call(this, options)
      }
    })
    await page.mouse.click(sel.x, sel.y, { button: 'right' })
    let shown = false
    for (let i = 0; i < 30 && !shown; i++) {
      await page.waitForTimeout(100)
      shown = await app.evaluate(() => globalThis.__nativeShown)
    }
    record('the native menu opens on a right-click', shown)
    await page.waitForTimeout(600)
    await clearClip()
    // On macOS the Copy item sends copy: to the key window, the same as
    // Edit > Copy (Cmd+C). The test window is not key (making it key would take
    // the keyboard focus from the user), so this checks the copy command of the
    // page with webContents.copy(), which the item runs on Linux and Windows.
    const copied = await app.evaluate(async ({ BrowserWindow, clipboard }) => {
      BrowserWindow.getAllWindows()[0].webContents.copy()
      await new Promise((r) => setTimeout(r, 500))
      return clipboard.readText()
    })
    record('Copy copies the selected text (webContents.copy)', copied === sel.text, {
      want: sel.text,
      got: copied
    })
  }

  // 7. A text field -> edit items, enabled from the field state.
  await go('/search', 200)
  await page.waitForTimeout(2000)
  const field = await page.evaluate(() => {
    const el = [...document.querySelectorAll('input, textarea')].find(
      (e) => e.offsetParent && !['checkbox', 'radio', 'button'].includes(e.type)
    )
    if (!el) return null
    el.setAttribute('data-ctx-field', '1')
    return true
  })
  if (!field) record('text field', false, 'no text field on /search')
  else {
    await page.click('[data-ctx-field]')
    await page.keyboard.type('hello world')
    await page.keyboard.press('Shift+Home')
    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted'))
    const r = await page.evaluate(() => {
      const b = document.querySelector('[data-ctx-field]').getBoundingClientRect()
      return { x: b.left + 20, y: b.top + b.height / 2 }
    })
    const m = await rightClick(r)
    record(
      'text field: menu is Undo, Redo, Cut, Copy, Paste, Select All',
      JSON.stringify(labels(m)) === '["undo","redo","-","cut","copy","paste","selectall"]',
      labels(m)
    )
    record(
      'text field: Cut, Copy and Paste are enabled with a selection',
      ['cut', 'copy', 'paste'].every((x) => roleEnabled(m, x))
    )

    // Spelling: a misspelled word gets suggestions above the edit items.
    await page.click('[data-ctx-field]')
    await page.keyboard.press('Meta+A')
    await page.keyboard.type('recieve ')
    await page.waitForTimeout(1500)
    const r2 = await page.evaluate(() => {
      const b = document.querySelector('[data-ctx-field]').getBoundingClientRect()
      return { x: b.left + 22, y: b.top + b.height / 2 }
    })
    const m2 = await rightClick(r2)
    const l2 = labels(m2) ?? []
    record(
      'text field: a misspelled word gets suggestions',
      l2.includes('receive') && l2.includes('Learn Spelling'),
      l2
    )
  }

  const opened = await app.evaluate(() => globalThis.__opened)
  record('no test click opened an external browser', opened.length === 0, opened)
} catch (e) {
  record('test run', false, e.message.split('\n')[0])
} finally {
  if (clipboardSaved) {
    await app
      .evaluate(async ({ clipboard }) => {
        clipboard.clear()
        const saved = globalThis.__savedClipboard ?? []
        if (saved.length) await clipboard.write(saved)
        const want = saved.flatMap((i) => i.types).sort()
        const got = (await clipboard.read()).flatMap((i) => i.types).sort()
        return { want, got }
      })
      .then(({ want, got }) =>
        record(
          'clipboard put back as it was (types)',
          want.every((t) => got.includes(t)),
          { want, got }
        )
      )
      .catch((e) => record('clipboard put back', false, e.message))
  }
  await app.close().catch(() => {})
  const errors = logs.filter((l) => /pageerror|Failed to copy/.test(l))
  if (errors.length) console.log(errors.join('\n'))
  rmSync(OUT, { recursive: true, force: true })
  if (USER_DATA) rmSync(USER_DATA, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok).length
  console.log(`DONE ${results.length - failed}/${results.length} passed`)
  process.exitCode = failed ? 1 : 0
}
