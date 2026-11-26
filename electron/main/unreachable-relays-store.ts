// Fork (ChadFarrow/jumble): JSON file behind UnreachableRelays, so the app
// remembers relays that gave no answer across restarts.
// See docs/superpowers/specs/2026-11-26-unreachable-relays-design.md
import fs from 'node:fs'
import path from 'node:path'
import type { UnreachableRelayStorage } from '../../src/lib/unreachable-relays'

// 500 records are about 40 KB; a larger file is not ours.
const MAX_FILE_BYTES = 256 * 1024

/** `getFilePath` is called on each load and save, after Electron set userData. */
export function createUnreachableRelayStorage(getFilePath: () => string): UnreachableRelayStorage {
  return {
    load() {
      try {
        const file = getFilePath()
        if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return undefined
      }
    },
    save(records) {
      const file = getFilePath()
      const temp = `${file}.${process.pid}.tmp`
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        // Write, then rename: a crash leaves the old file or the new one.
        fs.writeFileSync(temp, JSON.stringify(records))
        fs.renameSync(temp, file)
      } catch {
        try {
          fs.rmSync(temp, { force: true })
        } catch {
          // Best effort.
        }
      }
    }
  }
}
