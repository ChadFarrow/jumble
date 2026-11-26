import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SmartPool } from './smart-pool'
import {
  FIRST_RECHECK_AFTER_MS,
  RECHECK_AFTER_MS,
  UnreachableRelays,
  type UnreachableRelayStorage
} from './unreachable-relays'

// Fork: a relay that gives no answer (nos.lol from Chad's home network) must not
// hold back reads. These tests drive the real SmartPool, ManagedRelay and
// nostr-tools AbstractRelay over a fake WebSocket.

const DEAD = 'wss://dead.example.com/'
const GOOD = 'wss://good.example.com/'
const DAY = 24 * 60 * 60 * 1000

type Mode = 'open' | 'silent' | 'refuse'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  static modes = new Map<string, Mode>()

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { message: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(url: string | URL) {
    this.url = url.toString()
    FakeWebSocket.instances.push(this)
    const mode = FakeWebSocket.modes.get(this.url) ?? 'open'
    if (mode === 'silent') return
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      if (mode === 'refuse') {
        this.readyState = FakeWebSocket.CLOSED
        this.onerror?.()
        return
      }
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(message: string) {
    this.sent.push(message)
    if (message.startsWith('["EVENT"')) {
      const eventId = JSON.parse(message)[1].id
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify(['OK', eventId, true, 'accepted']) })
      )
      return
    }
    if (!message.startsWith('["REQ"')) return
    const subId = JSON.parse(message)[1]
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) }))
  }

  close() {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSING
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ message: '' })
    })
  }
}

function memoryStorage(initial?: unknown) {
  const storage = {
    data: initial,
    saves: 0,
    load: () => storage.data,
    save: (records: unknown) => {
      storage.saves++
      storage.data = JSON.parse(JSON.stringify(records))
    }
  }
  return storage satisfies UnreachableRelayStorage
}

function createPool(storage = memoryStorage()) {
  const unreachable = new UnreachableRelays(storage)
  const pool = new SmartPool({
    websocketImplementation: FakeWebSocket as unknown as typeof WebSocket,
    unreachableRelays: unreachable
  })
  return { pool, unreachable, storage }
}

function socketsTo(url: string) {
  return FakeWebSocket.instances.filter((socket) => socket.url === url)
}

async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A one-shot read to DEAD that the caller gives up on after `closeAfter` ms,
 * while GOOD answers: the renderer's fetch pattern on a cold start. */
async function failOnce(pool: SmartPool, closeAfter = 9_000) {
  const good = pool.getRelay(GOOD).subscribe([{ kinds: [0] }], {})
  const dead = pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
  await flushPromises()
  await vi.advanceTimersByTimeAsync(closeAfter)
  dead.close()
  good.close()
  await flushPromises()
}

describe('UnreachableRelays with SmartPool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    FakeWebSocket.modes = new Map([[DEAD, 'silent']])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends a read at once after the relay gave no answer and the caller closed its REQ', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)

    const before = socketsTo(DEAD).length
    const oneose = vi.fn()
    const onclose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], { oneose, onclose })
    await flushPromises()

    expect(oneose).toHaveBeenCalledOnce()
    // The REQ stays open, so it can attach when the relay answers again.
    expect(onclose).not.toHaveBeenCalled()
    expect(socketsTo(DEAD)).toHaveLength(before)
  })

  it('marks a relay after a 10 s connect timeout on a long-lived REQ', async () => {
    const { pool, unreachable } = createPool()
    const good = pool.getRelay(GOOD).subscribe([{ kinds: [1] }], {})
    const dead = pool.getRelay(DEAD).subscribe([{ kinds: [1] }], {})
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unreachable.has(DEAD)).toBe(true)
    dead.close()
    good.close()
  })

  it('does not mark a relay after a fast refusal', async () => {
    FakeWebSocket.modes.set(DEAD, 'refuse')
    const { pool, unreachable } = createPool()
    const good = pool.getRelay(GOOD).subscribe([{ kinds: [1] }], {})
    const dead = pool.getRelay(DEAD).subscribe([{ kinds: [1] }], {})
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(unreachable.has(DEAD)).toBe(false)
    dead.close()
    good.close()

    const before = socketsTo(DEAD).length
    pool.getRelay(DEAD).subscribe([{ kinds: [1] }], {})
    await flushPromises()
    expect(socketsTo(DEAD).length).toBe(before + 1)
  })

  it('does not mark a relay when no other relay answered during the attempt', async () => {
    const { pool, unreachable } = createPool()
    const dead = pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
    await flushPromises()
    await vi.advanceTimersByTimeAsync(9_000)
    dead.close()
    await flushPromises()
    expect(unreachable.has(DEAD)).toBe(false)
  })

  it('does not mark a relay when the caller gave up early', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool, 3_000)
    expect(unreachable.has(DEAD)).toBe(false)
  })

  it('keeps the mark across a restart', async () => {
    const storage = memoryStorage()
    await failOnce(createPool(storage).pool)

    const { pool } = createPool(storage)
    const oneose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], { oneose })
    await flushPromises()
    expect(oneose).toHaveBeenCalledOnce()
  })

  it('re-checks in the background after 5 minutes and uses the relay again when it answers', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS)
    FakeWebSocket.modes.set(DEAD, 'open')

    const before = socketsTo(DEAD).length
    const oneose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], { oneose })
    await flushPromises()
    // The read still ends at once; the check runs beside it.
    expect(oneose).toHaveBeenCalledOnce()
    expect(socketsTo(DEAD).length).toBe(before + 1)
    expect(unreachable.has(DEAD)).toBe(false)

    const sub = pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
    await flushPromises()
    const socket = socketsTo(DEAD).at(-1)!
    expect(socket.sent.some((message) => message.startsWith('["REQ"'))).toBe(true)
    sub.close()
  })

  it('keeps skipping after a failed re-check, with no new connection until the next check', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS)

    const before = socketsTo(DEAD).length
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
    await flushPromises()
    expect(socketsTo(DEAD).length).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unreachable.has(DEAD)).toBe(true)

    const oneose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], { oneose })
    await flushPromises()
    expect(oneose).toHaveBeenCalledOnce()
    expect(socketsTo(DEAD).length).toBe(before + 1)
  })

  it('re-checks at once after the network comes back online', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)
    pool.setNetworkOnline(false)
    pool.setNetworkOnline(true)

    const before = socketsTo(DEAD).length
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
    await flushPromises()
    expect(socketsTo(DEAD).length).toBe(before + 1)
  })

  it('still publishes to a marked relay, and a handshake clears the mark', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)
    FakeWebSocket.modes.set(DEAD, 'open')

    await pool.getRelay(DEAD).publish({ id: 'event-id' } as never)
    expect(unreachable.has(DEAD)).toBe(false)
  })

  it('fires nothing for a skipped REQ that its caller closed at once', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)

    const oneose = vi.fn()
    const onclose = vi.fn()
    const sub = pool.getRelay(DEAD).subscribe([{ kinds: [0] }], { oneose, onclose })
    sub.close()
    await flushPromises()
    expect(oneose).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
  })

  it('attaches a skipped long-lived REQ when a re-check finds the relay again', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    expect(unreachable.has(DEAD)).toBe(true)
    await vi.advanceTimersByTimeAsync(FIRST_RECHECK_AFTER_MS)
    FakeWebSocket.modes.set(DEAD, 'open')

    const oneose = vi.fn()
    const onclose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [1], since: 5 }], { oneose, onclose })
    await flushPromises()
    expect(oneose).toHaveBeenCalledOnce()
    const socket = socketsTo(DEAD).at(-1)!
    const reqs = socket.sent.filter((message) => message.startsWith('["REQ"'))
    expect(reqs).toHaveLength(1)
    expect(JSON.parse(reqs[0])[2]).toEqual({ kinds: [1], since: 5 })
    expect(onclose).not.toHaveBeenCalled()
  })

  it('keeps a skipped REQ open, with no retries, while the relay stays silent', async () => {
    const { pool, unreachable } = createPool()
    await failOnce(pool)
    await vi.advanceTimersByTimeAsync(FIRST_RECHECK_AFTER_MS)

    const onclose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [1] }], { onclose })
    await flushPromises()
    const afterCheck = socketsTo(DEAD).length
    // The re-check times out; no retry follows, and the REQ is not closed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(unreachable.has(DEAD)).toBe(true)
    expect(socketsTo(DEAD)).toHaveLength(afterCheck)
    expect(onclose).not.toHaveBeenCalled()
  })

  it('keeps a long-lived REQ open, with no retries, once its relay is marked', async () => {
    const { pool, unreachable } = createPool()
    const good = pool.getRelay(GOOD).subscribe([{ kinds: [1] }], {})
    const onclose = vi.fn()
    const oneose = vi.fn()
    pool.getRelay(DEAD).subscribe([{ kinds: [1] }], { oneose, onclose })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unreachable.has(DEAD)).toBe(true)
    expect(oneose).toHaveBeenCalledOnce()

    const before = socketsTo(DEAD).length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socketsTo(DEAD)).toHaveLength(before)
    expect(onclose).not.toHaveBeenCalled()
    good.close()
  })

  it('does not connect to a marked relay on a health check before its re-check is due', async () => {
    const { pool } = createPool()
    await failOnce(pool)
    pool.getRelay(DEAD).subscribe([{ kinds: [1] }], {})
    await flushPromises()
    const before = socketsTo(DEAD).length

    await pool.checkRelays()
    await flushPromises()
    expect(socketsTo(DEAD)).toHaveLength(before)
  })

  it('re-checks a marked relay with an open REQ on a health check when due', async () => {
    const { pool } = createPool()
    await failOnce(pool)
    pool.getRelay(DEAD).subscribe([{ kinds: [1] }], {})
    await flushPromises()
    await vi.advanceTimersByTimeAsync(FIRST_RECHECK_AFTER_MS)
    const before = socketsTo(DEAD).length

    void pool.checkRelays()
    await flushPromises()
    expect(socketsTo(DEAD)).toHaveLength(before + 1)
  })

  it('leaves a pool without the option unchanged', async () => {
    const pool = new SmartPool({
      websocketImplementation: FakeWebSocket as unknown as typeof WebSocket
    })
    await failOnce(pool)
    const before = socketsTo(DEAD).length
    pool.getRelay(DEAD).subscribe([{ kinds: [0] }], {})
    await flushPromises()
    expect(socketsTo(DEAD).length).toBe(before + 1)
  })
})

describe('UnreachableRelays records', () => {
  const NOW = Date.UTC(2026, 10, 26, 12)
  const ok = { ok: true, startedAt: NOW - 100, endedAt: NOW - 50, networkOnline: true }
  const slow = { ok: false, startedAt: NOW - 10_000, endedAt: NOW, networkOnline: true }

  function relays(initial?: unknown) {
    const storage = memoryStorage(initial)
    return { relays: new UnreachableRelays(storage, () => NOW), storage }
  }

  it('marks after a slow failure while another relay answered', () => {
    const { relays: r, storage } = relays()
    r.attemptEnded(GOOD, ok)
    r.attemptEnded(DEAD, slow)
    expect(r.has(DEAD)).toBe(true)
    expect(storage.data).toEqual({ [DEAD]: { markedAt: NOW, checkedAt: NOW } })
  })

  it('does not mark an attempt made while offline', () => {
    const { relays: r } = relays()
    r.attemptEnded(GOOD, ok)
    r.attemptEnded(DEAD, { ...slow, networkOnline: false })
    expect(r.has(DEAD)).toBe(false)
  })

  it('does not mark an attempt longer than 15 s (a timer delayed by sleep)', () => {
    const { relays: r } = relays()
    r.attemptEnded(GOOD, ok)
    r.attemptEnded(DEAD, { ...slow, startedAt: NOW - 16_000 })
    expect(r.has(DEAD)).toBe(false)
  })

  it.each([
    ['a string', 'not json'],
    ['an array', [1, 2]],
    ['null', null],
    ['wrong field types', { [DEAD]: { markedAt: 'x', checkedAt: NOW } }],
    ['a record that is not an object', { [DEAD]: 5 }],
    ['a key that is not a relay URL', { 'https://x.example/': { markedAt: NOW, checkedAt: NOW } }]
  ])('treats saved data with %s as no record', (_name, data) => {
    const { relays: r } = relays(data)
    expect(r.has(DEAD)).toBe(false)
    expect(r.readDecision(DEAD)).toBeUndefined()
  })

  it('treats a storage that throws as empty', () => {
    const r = new UnreachableRelays(
      {
        load: () => {
          throw new Error('disk')
        },
        save: () => {
          throw new Error('disk')
        }
      },
      () => NOW
    )
    r.attemptEnded(GOOD, ok)
    expect(() => r.attemptEnded(DEAD, slow)).not.toThrow()
    expect(r.has(DEAD)).toBe(true)
  })

  it('drops records not checked for 30 days', () => {
    const { relays: r } = relays({
      [DEAD]: { markedAt: NOW - 40 * DAY, checkedAt: NOW - 31 * DAY },
      [GOOD]: { markedAt: NOW - 40 * DAY, checkedAt: NOW - 29 * DAY }
    })
    expect(r.has(DEAD)).toBe(false)
    expect(r.has(GOOD)).toBe(true)
  })

  it('keeps at most 500 records, dropping the oldest check first', () => {
    const saved: Record<string, { markedAt: number; checkedAt: number }> = {}
    for (let i = 0; i < 500; i++) {
      saved[`wss://r${i}.example.com/`] = { markedAt: NOW - DAY, checkedAt: NOW - DAY + i }
    }
    const { relays: r, storage } = relays(saved)
    r.attemptEnded(GOOD, ok)
    r.attemptEnded(DEAD, slow)
    expect(r.has(DEAD)).toBe(true)
    expect(r.has('wss://r0.example.com/')).toBe(false)
    expect(r.has('wss://r1.example.com/')).toBe(true)
    expect(Object.keys(storage.data as object)).toHaveLength(500)
  })

  it('asks for one re-check when the last check is 5 minutes old', () => {
    const { relays: r } = relays({
      [DEAD]: { markedAt: NOW - DAY, checkedAt: NOW - RECHECK_AFTER_MS + 1 }
    })
    expect(r.readDecision(DEAD)).toEqual({ recheck: false })
    const later = relays({
      [DEAD]: { markedAt: NOW - DAY, checkedAt: NOW - RECHECK_AFTER_MS }
    }).relays
    expect(later.readDecision(DEAD)).toEqual({ recheck: true })
    expect(later.readDecision(DEAD)).toEqual({ recheck: false })
  })

  it('re-checks a new mark after 30 s the first time', () => {
    const marked = (age: number) =>
      relays({ [DEAD]: { markedAt: NOW - age, checkedAt: NOW - age } }).relays.readDecision(DEAD)
    expect(marked(FIRST_RECHECK_AFTER_MS - 1)).toEqual({ recheck: false })
    expect(marked(FIRST_RECHECK_AFTER_MS)).toEqual({ recheck: true })
  })

  it('re-checks a mark whose last check is in the future (clock set back, bad file)', () => {
    const { relays: r } = relays({ [DEAD]: { markedAt: NOW - DAY, checkedAt: NOW + DAY } })
    expect(r.readDecision(DEAD)).toEqual({ recheck: true })
  })

  it('does not mark an attempt that spans a network change', () => {
    const { relays: r } = relays()
    r.attemptEnded(GOOD, ok)
    r.networkChanged(false)
    r.networkChanged(true)
    r.attemptEnded(DEAD, slow)
    expect(r.has(DEAD)).toBe(false)
  })

  it('does not mark an attempt that starts less than 10 s after a network change', () => {
    let now = NOW
    const r = new UnreachableRelays(memoryStorage(), () => now)
    r.networkChanged(true)
    now += 19_000
    r.attemptEnded(GOOD, { ...ok, startedAt: now - 100, endedAt: now - 50 })
    r.attemptEnded(DEAD, { ...slow, startedAt: now - 10_000, endedAt: now })
    expect(r.has(DEAD)).toBe(false)

    now += 2_000
    r.attemptEnded(DEAD, { ...slow, startedAt: now - 10_000, endedAt: now })
    expect(r.has(DEAD)).toBe(true)
  })

  it('keeps a mark due for a re-check when its check failed during a network change', () => {
    let now = NOW
    const r = new UnreachableRelays(
      memoryStorage({ [DEAD]: { markedAt: NOW - DAY, checkedAt: NOW - DAY } }),
      () => now
    )
    expect(r.readDecision(DEAD)).toEqual({ recheck: true })
    r.networkChanged(false)
    r.attemptEnded(DEAD, { ...slow, startedAt: now - 1_000, endedAt: now })
    now += 1_000
    expect(r.readDecision(DEAD)).toEqual({ recheck: true })
  })

  it('starts one re-check, not two, when the online event and the 5 minutes both apply', () => {
    const { relays: r } = relays({
      [DEAD]: { markedAt: NOW - RECHECK_AFTER_MS, checkedAt: NOW - RECHECK_AFTER_MS }
    })
    r.networkChanged(true)
    expect(r.readDecision(DEAD)?.recheck).toBe(true)
    expect(r.readDecision(DEAD)?.recheck).toBe(false)
  })
})
