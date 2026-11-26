import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUnreachableRelayStorage } from '../../electron/main/unreachable-relays-store'

// Fork: the Electron main store behind UnreachableRelays
// (userData/unreachable-relays.json).

describe('unreachable relay store (Electron main)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'unreachable-relays-'))
    file = path.join(dir, 'unreachable-relays.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads nothing when the file does not exist', () => {
    expect(createUnreachableRelayStorage(() => file).load()).toBeUndefined()
  })

  it('loads what it saved, and leaves no temporary file', () => {
    const storage = createUnreachableRelayStorage(() => file)
    const records = { 'wss://nos.lol/': { markedAt: 1, checkedAt: 2 } }
    storage.save(records)
    expect(createUnreachableRelayStorage(() => file).load()).toEqual(records)
    expect(readdirSync(dir)).toEqual(['unreachable-relays.json'])
  })

  it('loads nothing from a corrupt file', () => {
    writeFileSync(file, '{"wss://nos.lol/": {')
    expect(createUnreachableRelayStorage(() => file).load()).toBeUndefined()
  })

  it('loads nothing from a file over 256 KB', () => {
    writeFileSync(file, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }))
    expect(createUnreachableRelayStorage(() => file).load()).toBeUndefined()
  })

  it('does not throw when it cannot save', () => {
    const blocked = path.join(dir, 'not-a-dir')
    writeFileSync(blocked, '')
    const storage = createUnreachableRelayStorage(() => path.join(blocked, 'x.json'))
    expect(() => storage.save({})).not.toThrow()
  })
})
