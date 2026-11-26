import {
  clipboard,
  ClipboardItem,
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { isRendererFrameUrl } from './renderer-frame.js'

// Electron shows no context menu by default, so a right-click on selected
// text, a link, an image or a text field did nothing in the desktop app.
// This builds the native menu for those cases. Components that draw their own
// menu (DM list, DM messages, the like button) call preventDefault() on the
// DOM contextmenu event; Electron then emits no 'context-menu' event, so they
// keep their own menu and never get this one as well.

// The public web build serves the same routes, so an in-app link becomes a
// link that works outside the app. Same rule as toJumbleNote() in src/lib/link.ts.
const SHARE_ORIGIN = 'https://jumble.social'
const MAX_SPELLING_SUGGESTIONS = 5

export type TContextMenuImage = {
  src: string
  // true when Chromium's own hit test found the image (params.mediaType ===
  // 'image'), so webContents.copyImageAt() can copy it.
  hitTested: boolean
}

export type TContextMenuParams = Pick<
  ContextMenuParams,
  | 'x'
  | 'y'
  | 'linkURL'
  | 'isEditable'
  | 'selectionText'
  | 'editFlags'
  | 'misspelledWord'
  | 'dictionarySuggestions'
> & { image: TContextMenuImage | null }

export type TContextMenuActions = {
  copyText: (text: string) => void
  copyImage: (image: TContextMenuImage, x: number, y: number) => void
  saveImage: (url: string) => void
  replaceMisspelling: (word: string) => void
  addToDictionary: (word: string) => void
}

/**
 * Returns a URL that is useful outside the app, or null when there is none.
 * Links to the renderer's own origin (app://renderer/... in a packaged build,
 * the Vite server in development) map to the same path on jumble.social.
 */
export function toShareableUrl(url: string, rendererOrigin: string | null): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (isRendererFrameUrl(url, rendererOrigin)) {
    return `${SHARE_ORIGIN}${parsed.pathname}${parsed.search}${parsed.hash}`
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url
  if (parsed.protocol === 'nostr:' || parsed.protocol === 'mailto:') return url
  return null
}

export function buildContextMenuTemplate(
  params: TContextMenuParams,
  actions: TContextMenuActions,
  rendererOrigin: string | null
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = []
  const flags = params.editFlags

  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SPELLING_SUGGESTIONS)
    const group: MenuItemConstructorOptions[] = suggestions.map((word) => ({
      label: word,
      click: () => actions.replaceMisspelling(word)
    }))
    if (group.length === 0) group.push({ label: 'No Guesses Found', enabled: false })
    const misspelled = params.misspelledWord
    group.push({ label: 'Learn Spelling', click: () => actions.addToDictionary(misspelled) })
    groups.push(group)
  }

  const link = toShareableUrl(params.linkURL, rendererOrigin)
  if (link) {
    groups.push([{ label: 'Copy Link', click: () => actions.copyText(link) }])
  }

  const image = params.image
  if (image) {
    const imageUrl = toShareableUrl(image.src, rendererOrigin)
    const group: MenuItemConstructorOptions[] = []
    // An image the hit test missed is copied by its URL, so it needs one.
    if (image.hitTested || imageUrl) {
      group.push({
        label: 'Copy Image',
        click: () => actions.copyImage(image, params.x, params.y)
      })
    }
    if (imageUrl) {
      group.push({ label: 'Copy Image Address', click: () => actions.copyText(imageUrl) })
      group.push({ label: 'Save Image As…', click: () => actions.saveImage(image.src) })
    }
    if (group.length) groups.push(group)
  }

  if (params.isEditable) {
    groups.push([
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo }
    ])
    groups.push([
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'selectAll', enabled: flags.canSelectAll }
    ])
  } else if (params.selectionText.trim()) {
    groups.push([{ role: 'copy', enabled: flags.canCopy }])
  }

  return groups.flatMap((group, i) =>
    i === 0 ? group : [{ type: 'separator' } as MenuItemConstructorOptions, ...group]
  )
}

/**
 * Page script that returns the src of the <img> on top at the point (CSS
 * pixels), or null. Jumble draws its images with `pointer-events: none`
 * (src/components/Image), so Chromium's hit test skips them: the context menu
 * params report mediaType 'none' and webContents.copyImageAt() copies nothing.
 * An image under a dialog, a backdrop or another element does not count: the
 * script makes each candidate hit-testable for one elementFromPoint() call and
 * accepts it only when it is the element on top.
 */
export function findImageScript(x: number, y: number): string {
  return `(() => {
  const x = ${Number(x)}, y = ${Number(y)};
  const isOnTop = (img) => {
    const value = img.style.getPropertyValue('pointer-events');
    const priority = img.style.getPropertyPriority('pointer-events');
    img.style.setProperty('pointer-events', 'auto', 'important');
    try {
      return document.elementFromPoint(x, y) === img;
    } finally {
      if (value) img.style.setProperty('pointer-events', value, priority);
      else img.style.removeProperty('pointer-events');
    }
  };
  const seen = new Set();
  for (const el of document.elementsFromPoint(x, y)) {
    const imgs = el instanceof HTMLImageElement ? [el] : el.querySelectorAll('img');
    for (const img of imgs) {
      if (seen.has(img)) continue;
      seen.add(img);
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:') || !img.complete || img.naturalWidth === 0) continue;
      const style = getComputedStyle(img);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      const r = img.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (isOnTop(img)) return src;
    }
  }
  return null;
})()`
}

/**
 * Page script that decodes the image at `src` and returns it as base64 PNG.
 * The page decodes WebP, GIF and AVIF; Electron's nativeImage does not. The
 * main process adds Access-Control-Allow-Origin to the renderer's responses,
 * so the fetch is allowed.
 */
export function imageToPngScript(src: string): string {
  return `(async () => {
  const res = await fetch(${JSON.stringify(src)});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
})()`
}

async function findImage(
  contents: WebContents,
  params: ContextMenuParams
): Promise<TContextMenuImage | null> {
  if (params.mediaType === 'image' && params.srcURL) {
    return { src: params.srcURL, hitTested: true }
  }
  // params.x/y are in window pixels; the page works in CSS pixels.
  const zoom = contents.getZoomFactor() || 1
  try {
    const src = await contents.executeJavaScript(findImageScript(params.x / zoom, params.y / zoom))
    return typeof src === 'string' && src ? { src, hitTested: false } : null
  } catch {
    return null
  }
}

async function copyImageByUrl(contents: WebContents, src: string) {
  const base64 = await contents.executeJavaScript(imageToPngScript(src))
  const png = Buffer.from(String(base64), 'base64')
  await clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })
  ])
}

export function attachContextMenu(win: BrowserWindow, getRendererOrigin: () => string | null) {
  const contents = win.webContents
  const actions: TContextMenuActions = {
    copyText: (text) => {
      // The Electron clipboard API is asynchronous (Promise based).
      clipboard.writeText(text).catch((error) => console.error('Failed to copy text:', error))
    },
    copyImage: (image, x, y) => {
      if (image.hitTested) {
        contents.copyImageAt(x, y)
        return
      }
      copyImageByUrl(contents, image.src).catch((error) =>
        console.error('Failed to copy image:', error)
      )
    },
    saveImage: (url) => contents.downloadURL(url),
    replaceMisspelling: (word) => contents.replaceMisspelling(word),
    addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word)
  }

  contents.on('context-menu', async (_event, params) => {
    const image = await findImage(contents, params)
    if (win.isDestroyed()) return
    const template = buildContextMenuTemplate({ ...params, image }, actions, getRendererOrigin())
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
