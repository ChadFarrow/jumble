// Fork (ChadFarrow/jumble): when two remote signers hold the same key (Chad's
// Clave and Amber), each request reaches both. The signer that does not know
// this app (Amber) refuses at once, before the signer that the user paired
// (Clave) answers, and nostr-tools takes the first answer. So the login, and
// each later request, failed. Such a refusal is dropped here: the request
// waits for the next answer, or fails on its normal timeout.
// Design: docs/superpowers/specs/2026-11-26-nip46-skip-unknown-refusal-design.md
import type { Event } from 'nostr-tools'
import { v2 as nip44 } from 'nostr-tools/nip44'

/** Amber's refusals to an app that it has no connection with: any request
 * ("no permission", Nip46Admission.kt) and a connect whose secret it does not
 * know ("invalid secret", Nip46Requests.kt). Clave uses other texts. */
export const UNKNOWN_CLIENT_REFUSALS: ReadonlySet<string> = new Set([
  'no permission',
  'invalid secret'
])

/** True for a NIP-46 response, encrypted to this client, whose error is
 * exactly one of UNKNOWN_CLIENT_REFUSALS. Anything it cannot read is kept. */
export function createUnknownRefusalCheck(clientSecretKey: Uint8Array) {
  const conversationKeys = new Map<string, Uint8Array>()
  return (event: Event): boolean => {
    if (event.kind !== 24133) return false
    try {
      let key = conversationKeys.get(event.pubkey)
      if (!key) {
        key = nip44.utils.getConversationKey(clientSecretKey, event.pubkey)
        conversationKeys.set(event.pubkey, key)
      }
      const response = JSON.parse(nip44.decrypt(event.content, key))
      return typeof response?.error === 'string' && UNKNOWN_CLIENT_REFUSALS.has(response.error)
    } catch {
      return false
    }
  }
}
