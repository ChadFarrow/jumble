import { describe, expect, it, vi } from 'vitest'

import vm from 'node:vm'

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), write: vi.fn() },
  ClipboardItem: class {},
  Menu: { buildFromTemplate: vi.fn() }
}))

import {
  buildContextMenuTemplate,
  findImageScript,
  imageToPngScript,
  toShareableUrl,
  type TContextMenuActions,
  type TContextMenuParams
} from '../../electron/main/context-menu'

const APP_ORIGIN = 'app://renderer'

const allEditFlags = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false
}

function params(overrides: Partial<TContextMenuParams> = {}): TContextMenuParams {
  return {
    x: 10,
    y: 20,
    linkURL: '',
    image: null,
    isEditable: false,
    selectionText: '',
    editFlags: { ...allEditFlags, canCopy: false, canCut: false, canPaste: false },
    misspelledWord: '',
    dictionarySuggestions: [],
    ...overrides
  }
}

function actions(): TContextMenuActions {
  return {
    copyText: vi.fn(),
    copyImage: vi.fn(),
    saveImage: vi.fn(),
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn()
  }
}

// Labels for custom items, the role for role items, '-' for separators.
function shape(template: ReturnType<typeof buildContextMenuTemplate>) {
  return template.map((item) => (item.type === 'separator' ? '-' : (item.role ?? item.label)))
}

function click(template: ReturnType<typeof buildContextMenuTemplate>, label: string) {
  const item = template.find((i) => i.label === label)
  if (!item?.click) throw new Error(`no clickable item "${label}"`)
  ;(item.click as () => void)()
}

describe('toShareableUrl', () => {
  it('maps in-app links to the same path on jumble.social', () => {
    expect(toShareableUrl('app://renderer/notes/nevent1abc?x=1#top', APP_ORIGIN)).toBe(
      'https://jumble.social/notes/nevent1abc?x=1#top'
    )
  })

  it('maps links to the Vite development server the same way', () => {
    expect(toShareableUrl('http://localhost:5173/users/npub1xyz', 'http://localhost:5173')).toBe(
      'https://jumble.social/users/npub1xyz'
    )
  })

  it('keeps web, nostr and mailto links as they are', () => {
    expect(toShareableUrl('https://example.com/a', APP_ORIGIN)).toBe('https://example.com/a')
    expect(toShareableUrl('nostr:npub1xyz', APP_ORIGIN)).toBe('nostr:npub1xyz')
    expect(toShareableUrl('mailto:a@example.com', APP_ORIGIN)).toBe('mailto:a@example.com')
  })

  it('drops links that mean nothing outside the app', () => {
    expect(toShareableUrl('', APP_ORIGIN)).toBeNull()
    expect(toShareableUrl('not a url', APP_ORIGIN)).toBeNull()
    expect(toShareableUrl('blob:app://renderer/1234', APP_ORIGIN)).toBeNull()
    expect(toShareableUrl('javascript:alert(1)', APP_ORIGIN)).toBeNull()
    expect(toShareableUrl('app://third-party/x', APP_ORIGIN)).toBeNull()
  })
})

describe('buildContextMenuTemplate', () => {
  it('shows no menu when nothing is selected, linked or editable', () => {
    expect(buildContextMenuTemplate(params(), actions(), APP_ORIGIN)).toEqual([])
  })

  it('shows no menu for a selection of only white space', () => {
    expect(
      buildContextMenuTemplate(params({ selectionText: '  \n' }), actions(), APP_ORIGIN)
    ).toEqual([])
  })

  it('offers Copy for selected text in a note', () => {
    const template = buildContextMenuTemplate(
      params({ selectionText: 'hello', editFlags: { ...allEditFlags, canCopy: true } }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template)).toEqual(['copy'])
    expect(template[0].enabled).toBe(true)
  })

  it('offers the edit items in a text field, enabled from the edit flags', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { ...allEditFlags, canUndo: false, canCut: false, canCopy: false }
      }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template)).toEqual(['undo', 'redo', '-', 'cut', 'copy', 'paste', 'selectAll'])
    const enabled = Object.fromEntries(
      template.filter((i) => i.role).map((i) => [i.role, i.enabled])
    )
    expect(enabled).toEqual({
      undo: false,
      redo: true,
      cut: false,
      copy: false,
      paste: true,
      selectAll: true
    })
  })

  it('copies an in-app link as a jumble.social link', () => {
    const a = actions()
    const template = buildContextMenuTemplate(
      params({ linkURL: 'app://renderer/users/npub1xyz' }),
      a,
      APP_ORIGIN
    )
    expect(shape(template)).toEqual(['Copy Link'])
    click(template, 'Copy Link')
    expect(a.copyText).toHaveBeenCalledWith('https://jumble.social/users/npub1xyz')
  })

  it('puts Copy Link above Copy when the selected text is a link', () => {
    const template = buildContextMenuTemplate(
      params({
        linkURL: 'https://example.com/',
        selectionText: 'example',
        editFlags: { ...allEditFlags, canCopy: true }
      }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template)).toEqual(['Copy Link', '-', 'copy'])
  })

  it('offers image items and runs each action with the right value', () => {
    const a = actions()
    const src = 'https://image.nostr.build/abc.jpg'
    const image = { src, hitTested: false }
    const template = buildContextMenuTemplate(params({ image, x: 33, y: 44 }), a, APP_ORIGIN)
    expect(shape(template)).toEqual(['Copy Image', 'Copy Image Address', 'Save Image As…'])
    click(template, 'Copy Image')
    expect(a.copyImage).toHaveBeenCalledWith(image, 33, 44)
    click(template, 'Copy Image Address')
    expect(a.copyText).toHaveBeenCalledWith(src)
    click(template, 'Save Image As…')
    expect(a.saveImage).toHaveBeenCalledWith(src)
  })

  it('offers only Copy Image for a hit-tested image with no useful address', () => {
    const template = buildContextMenuTemplate(
      params({ image: { src: 'blob:app://renderer/1234', hitTested: true } }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template)).toEqual(['Copy Image'])
  })

  it('offers no image items for a found image it cannot fetch', () => {
    const template = buildContextMenuTemplate(
      params({ image: { src: 'blob:app://renderer/1234', hitTested: false } }),
      actions(),
      APP_ORIGIN
    )
    expect(template).toEqual([])
  })

  it('combines a linked image: link first, then image', () => {
    const template = buildContextMenuTemplate(
      params({
        linkURL: 'https://example.com/',
        image: { src: 'https://example.com/a.png', hitTested: false }
      }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template)).toEqual([
      'Copy Link',
      '-',
      'Copy Image',
      'Copy Image Address',
      'Save Image As…'
    ])
  })

  it('offers spelling suggestions above the edit items in a text field', () => {
    const a = actions()
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: allEditFlags,
        misspelledWord: 'nostrr',
        dictionarySuggestions: ['nostr', 'nostrum', 'a', 'b', 'c', 'd']
      }),
      a,
      APP_ORIGIN
    )
    expect(shape(template)).toEqual([
      'nostr',
      'nostrum',
      'a',
      'b',
      'c',
      'Learn Spelling',
      '-',
      'undo',
      'redo',
      '-',
      'cut',
      'copy',
      'paste',
      'selectAll'
    ])
    click(template, 'nostr')
    expect(a.replaceMisspelling).toHaveBeenCalledWith('nostr')
    click(template, 'Learn Spelling')
    expect(a.addToDictionary).toHaveBeenCalledWith('nostrr')
  })

  it('says so when the spell checker has no suggestion', () => {
    const template = buildContextMenuTemplate(
      params({ isEditable: true, editFlags: allEditFlags, misspelledWord: 'zzqx' }),
      actions(),
      APP_ORIGIN
    )
    expect(shape(template).slice(0, 3)).toEqual(['No Guesses Found', 'Learn Spelling', '-'])
    expect(template[0].enabled).toBe(false)
  })
})

type TFakeImage = {
  src: string
  rect: [number, number, number, number]
  opacity?: string
  // Another element (a dialog, a backdrop) lies on top of this image.
  covered?: boolean
}

// Runs the page script against a fake DOM with one container that holds the
// images. Like Chromium, elementFromPoint() skips an image until the script
// makes it hit-testable, and then returns the image, or the element on top of it.
function runFindImage(imgs: TFakeImage[], x: number, y: number) {
  class HTMLImageElement {}
  const cover = { cover: true }
  const images = imgs.map((i) => {
    const props = new Map<string, string>()
    return Object.assign(new HTMLImageElement(), {
      currentSrc: i.src,
      src: i.src,
      complete: true,
      naturalWidth: 100,
      opacity: i.opacity ?? '1',
      covered: !!i.covered,
      props,
      style: {
        getPropertyValue: (k: string) => props.get(k) ?? '',
        getPropertyPriority: () => '',
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k)
      },
      getBoundingClientRect: () => ({
        left: i.rect[0],
        top: i.rect[1],
        right: i.rect[2],
        bottom: i.rect[3]
      })
    })
  })
  const inside = (img: (typeof images)[number]) => {
    const r = img.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }
  // The hit stack: a wrapper div (the img itself has pointer-events: none).
  const wrapper = { querySelectorAll: () => images }
  const context = {
    HTMLImageElement,
    document: {
      elementsFromPoint: () => [wrapper],
      elementFromPoint: () => {
        const hit = images.find((i) => i.props.get('pointer-events') === 'auto' && inside(i))
        if (!hit) return wrapper
        return hit.covered ? cover : hit
      }
    },
    getComputedStyle: (img: { opacity: string }) => ({
      visibility: 'visible',
      opacity: img.opacity
    })
  }
  const result = vm.runInNewContext(findImageScript(x, y), context)
  return { result, styleLeftOver: images.some((i) => i.props.size > 0) }
}

describe('findImageScript', () => {
  it('finds the image under the point inside a wrapper', () => {
    expect(
      runFindImage(
        [
          { src: 'https://a/1.webp', rect: [0, 0, 50, 50] },
          { src: 'https://a/2.webp', rect: [60, 0, 110, 50] }
        ],
        80,
        25
      ).result
    ).toBe('https://a/2.webp')
  })

  it('ignores an image under a dialog or backdrop', () => {
    expect(
      runFindImage([{ src: 'https://a/feed.jpg', rect: [0, 0, 100, 100], covered: true }], 50, 50)
        .result
    ).toBeNull()
  })

  it('puts the image style back after the check', () => {
    expect(
      runFindImage([{ src: 'https://a/1.jpg', rect: [0, 0, 50, 50] }], 25, 25).styleLeftOver
    ).toBe(false)
  })

  it('skips hidden images and data: spacers', () => {
    expect(
      runFindImage(
        [
          { src: 'data:image/svg+xml,%3Csvg%3E', rect: [0, 0, 50, 50] },
          { src: 'https://a/loading.jpg', rect: [0, 0, 50, 50], opacity: '0' }
        ],
        25,
        25
      ).result
    ).toBeNull()
  })

  it('returns null when no image is under the point', () => {
    expect(
      runFindImage([{ src: 'https://a/1.jpg', rect: [0, 0, 50, 50] }], 200, 200).result
    ).toBeNull()
  })

  it('accepts only numbers as coordinates', () => {
    const script = findImageScript('1); alert(1' as unknown as number, 2)
    expect(script).toContain('const x = NaN, y = 2;')
  })
})

describe('imageToPngScript', () => {
  it('embeds the URL as a safe string literal', () => {
    const src = 'https://a/x".png?q=</script>'
    expect(imageToPngScript(src)).toContain(`fetch(${JSON.stringify(src)})`)
  })
})
