import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * electron-builder writes `app-update.yml` into the app's resources only when
 * the build has a publish target. Without it electron-updater has nowhere to
 * look for updates. The fork's own macOS build ("Jumble Chad",
 * scripts/fork/electron-builder.chad.cjs) has no publish target on purpose, so
 * upstream releases can never replace it.
 */
export function hasUpdateConfig(resourcesPath: string | undefined = process.resourcesPath) {
  if (!resourcesPath) return false
  return existsSync(path.join(resourcesPath, 'app-update.yml'))
}
