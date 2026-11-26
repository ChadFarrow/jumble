import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)

function pngSize(file: string) {
  const buf = readFileSync(file)
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('Jumble Chad app icon (fork build)', () => {
  const chad = require(path.join(REPO, 'scripts/fork/electron-builder.chad.cjs'))
  const base = require(path.join(REPO, 'electron-builder.config.cjs'))

  it('uses the fork icon for the macOS build', () => {
    expect(chad.mac.icon).toBe('scripts/fork/icon-chad.png')
  })

  it('has a 1024 x 1024 PNG icon file', () => {
    const file = path.join(REPO, chad.mac.icon)
    expect(existsSync(file)).toBe(true)
    expect(pngSize(file)).toEqual({ width: 1024, height: 1024 })
  })

  it('keeps the SVG source next to the PNG', () => {
    expect(existsSync(path.join(REPO, 'scripts/fork/icon-chad.svg'))).toBe(true)
  })

  it("does not use upstream's icon", () => {
    expect(chad.mac.icon).not.toBe(base.mac.icon)
  })
})
