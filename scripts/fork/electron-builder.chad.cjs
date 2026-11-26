// electron-builder config for Chad's own macOS build, "Jumble Chad".
// Fork-only. Built by scripts/fork/build-mac.sh.
//
// It is a separate app from upstream's Jumble:
// - its own appId and name, so its own data folder
//   (~/Library/Application Support/Jumble Chad) and its own Keychain item
//   ("Jumble Chad Safe Storage"); the installed upstream Jumble keeps its data;
// - no publish target, so no app-update.yml and no auto-update from upstream
//   releases (see electron/main/update-config.ts);
// - ad-hoc signed and not notarized: a local build for this Mac only.
const base = require('../../electron-builder.config.cjs')

module.exports = {
  ...base,
  appId: 'com.chadfarrow.jumble',
  productName: 'Jumble Chad',
  // app.getName() reads productName from the packaged package.json; the data
  // folder and the Keychain item take their names from it.
  extraMetadata: { productName: 'Jumble Chad' },
  publish: null,
  directories: { ...base.directories, output: 'release/chad-${version}' },
  mac: {
    ...base.mac,
    identity: '-',
    notarize: false,
    target: [{ target: 'dir', arch: ['arm64'] }],
    artifactName: 'Jumble-Chad-mac-${arch}.${ext}'
  }
}
