import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasUpdateConfig } from '../../electron/main/update-config'

describe('hasUpdateConfig', () => {
  const dirs: string[] = []
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jumble-update-config-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  it('is true when the build wrote app-update.yml', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'app-update.yml'), 'provider: github\n')
    expect(hasUpdateConfig(dir)).toBe(true)
  })

  it('is false for a build with no publish target', () => {
    expect(hasUpdateConfig(tempDir())).toBe(false)
  })

  it('is false when there is no resources path', () => {
    expect(hasUpdateConfig(undefined)).toBe(false)
    expect(hasUpdateConfig('')).toBe(false)
  })
})
