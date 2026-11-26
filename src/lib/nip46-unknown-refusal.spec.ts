// Fork (ChadFarrow/jumble): two remote signers hold the same key (Chad's Clave
// and Amber). The one that does not know this app answers "no permission"
// first; the request must wait for the other signer's answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilter,
  type Filter
} from 'nostr-tools'
import { BunkerSigner } from 'nostr-tools/nip46'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { Nip46Pool } from './nip46-pool'
import { SmartPool } from './smart-pool'

vi.mock('./nostr-verifier', async () => {
  const { verifyEvent } = await import('nostr-tools/pure')
  return { initializeNostrVerifier: async () => true, verifyEvent }
})

const URL = 'wss://signer.example/'
const remoteSecret = generateSecretKey()
const remotePubkey = getPublicKey(remoteSecret)
const clientSecret = generateSecretKey()
const conversationKey = nip44.utils.getConversationKey(remoteSecret, getPublicKey(clientSecret))

type Answer = { result?: string; error?: string }
/** The answers each request gets, in order: [first signer, second signer]. */
let answer: (method: string) => (Answer | null)[]

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  subscriptions = new Map<string, Filter[]>()
  onopen: (() => void) | null = null
  onclose: ((event: { message: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(_url: string | URL) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(message: string) {
    const [type, payload, ...filters] = JSON.parse(message)
    if (type === 'REQ') {
      this.subscriptions.set(payload, filters)
      this.receive(['EOSE', payload])
    } else if (type === 'CLOSE') {
      this.subscriptions.delete(payload)
    } else if (type === 'EVENT') {
      this.receive(['OK', payload.id, true, ''])
      if (payload.kind !== 24133) return
      const { id, method } = JSON.parse(nip44.decrypt(payload.content, conversationKey))
      for (const a of answer(method)) {
        if (!a) continue
        const response = finalizeEvent(
          {
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', payload.pubkey]],
            content: nip44.encrypt(JSON.stringify({ id, result: '', ...a }), conversationKey)
          },
          remoteSecret
        )
        for (const [subId, subFilters] of this.subscriptions) {
          if (subFilters.some((filter) => matchFilter(filter, response))) {
            this.receive(['EVENT', subId, response])
          }
        }
      }
    }
  }

  receive(frame: unknown[]) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }))
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.subscriptions.clear()
    this.onclose?.({ message: 'connection lost' })
  }
}

async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('NIP-46: a refusal from another signer of the same key', () => {
  let pool: SmartPool
  let signer: BunkerSigner

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('addEventListener', () => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    FakeWebSocket.instances = []
    pool = new SmartPool({ websocketImplementation: FakeWebSocket as unknown as typeof WebSocket })
    signer = BunkerSigner.fromBunker(
      clientSecret,
      { pubkey: remotePubkey, relays: [URL], secret: null },
      { pool: new Nip46Pool(pool, undefined, { clientSecretKey: clientSecret }) }
    )
  })

  afterEach(async () => {
    await signer.close()
    pool.close([URL])
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the second answer when the first is "no permission"', async () => {
    answer = (method) => [
      { error: 'no permission' },
      { result: method === 'get_public_key' ? remotePubkey : 'ack' }
    ]
    await expect(signer.connect()).resolves.toBeUndefined()
    await expect(signer.getPublicKey()).resolves.toBe(remotePubkey)
  })

  it('uses the second answer when the first refuses connect with "invalid secret"', async () => {
    // Amber's answer to a connect whose secret it does not know (Nip46Requests.kt).
    answer = (method) =>
      method === 'connect' ? [{ error: 'invalid secret' }, { result: 'ack' }] : [null, null]
    await expect(signer.connect()).resolves.toBeUndefined()
  })

  it('waits for the timeout when "no permission" is the only answer', async () => {
    answer = () => [{ error: 'no permission' }, null]
    const result = signer.ping().then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await flushPromises()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(await Promise.race([result, Promise.resolve('pending')])).toBe('pending')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toMatch(/timeout/)
  })

  it('still rejects at once on any other error', async () => {
    answer = () => [{ error: 'user rejected' }, { result: 'pong' }]
    await expect(signer.ping()).rejects.toThrow('user rejected')
  })

  it('still rejects on "no permission" when no client key is given (upstream behavior)', async () => {
    await signer.close()
    signer = BunkerSigner.fromBunker(
      clientSecret,
      { pubkey: remotePubkey, relays: [URL], secret: null },
      { pool: new Nip46Pool(pool) }
    )
    answer = () => [{ error: 'no permission' }, { result: 'pong' }]
    await expect(signer.ping()).rejects.toThrow('no permission')
  })
})
