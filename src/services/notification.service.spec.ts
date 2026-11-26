import { NostrEvent } from 'nostr-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TOnEvents = (events: NostrEvent[], eosed: boolean) => void

const mocks = vi.hoisted(() => ({
  stored: [] as NostrEvent[],
  handlers: [] as { onEvents: TOnEvents; onNew: (evt: NostrEvent) => void }[]
}))

vi.mock('@/services/client.service', () => ({
  default: {
    getEventsFromIndexed: vi.fn(async () => mocks.stored),
    fetchRelayList: vi.fn(async () => ({
      read: ['wss://a/', 'wss://b/', 'wss://c/', 'wss://d/'],
      write: [],
      originalRelays: []
    })),
    subscribeTimeline: vi.fn(async (_req, handlers) => {
      mocks.handlers.push(handlers)
      return { closer: vi.fn(), timelineKey: 'k' }
    }),
    loadMoreTimeline: vi.fn(async () => [])
  }
}))
vi.mock('@/services/thread.service', () => ({ default: { addRepliesToThread: vi.fn() } }))
vi.mock('@/services/stuff-stats.service', () => ({
  default: { updateStuffStatsByEvents: vi.fn() }
}))
vi.mock('@/lib/relay', () => ({ getDefaultRelayUrls: () => ['wss://default/'] }))

import stuffStatsService from '@/services/stuff-stats.service'
import threadService from '@/services/thread.service'
import notificationService from './notification.service'

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function evt(id: string, createdAt: number, pubkey = OTHER): NostrEvent {
  return {
    id: id.padEnd(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: 1,
    tags: [['p', ME]],
    content: '',
    sig: ''
  }
}

const ids = () => notificationService.getEvents().map((e) => e.id[0] + e.id[1])
const lastOnEvents = () => mocks.handlers[mocks.handlers.length - 1].onEvents

describe('notificationService partial relay results', () => {
  const s1 = evt('s1', 100)
  const s2 = evt('s2', 200)
  const e1 = evt('e1', 300)
  const e2 = evt('e2', 400)
  const e3 = evt('e3', 500)
  const e9 = evt('e9', 900)

  beforeEach(() => {
    mocks.stored = []
    mocks.handlers = []
    vi.clearAllMocks()
  })

  afterEach(() => {
    notificationService.stop()
  })

  it("shows a relay's events before the other relays answer", async () => {
    await notificationService.start(ME)
    const listener = vi.fn()
    const off = notificationService.onDataChanged(listener)

    lastOnEvents()([e3, e2], false)

    expect(ids()).toEqual(['e3', 'e2'])
    expect(notificationService.getInitialLoading()).toBe(true)
    expect(notificationService.hasMore()).toBe(false)
    expect(listener).toHaveBeenCalled()
    off()
  })

  it('keeps saved notifications when a fast relay returns only a few', async () => {
    mocks.stored = [s2, s1]
    await notificationService.start(ME)

    lastOnEvents()([e9], false)

    expect(ids()).toEqual(['e9', 's2', 's1'])
  })

  it('does not duplicate events already shown', async () => {
    mocks.stored = [s2, s1]
    await notificationService.start(ME)

    lastOnEvents()([s2], false)

    expect(ids()).toEqual(['s2', 's1'])
  })

  it("drops the account's own events from a partial result", async () => {
    await notificationService.start(ME)

    lastOnEvents()([evt('ow', 600, ME), e1], false)

    expect(ids()).toEqual(['e1'])
  })

  it('changes nothing for an empty partial result', async () => {
    mocks.stored = [s1]
    await notificationService.start(ME)
    const listener = vi.fn()
    const off = notificationService.onDataChanged(listener)

    lastOnEvents()([], false)

    expect(ids()).toEqual(['s1'])
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('ignores results for an account that is no longer current', async () => {
    await notificationService.start(ME)
    const onEvents = lastOnEvents()
    notificationService.stop()

    onEvents([e1], false)

    expect(notificationService.getEvents()).toEqual([])
  })

  it('finishes loading when the last relay answers', async () => {
    await notificationService.start(ME)
    lastOnEvents()([e2], false)

    lastOnEvents()([e3, e2], true)

    expect(ids()).toEqual(['e3', 'e2'])
    expect(notificationService.getInitialLoading()).toBe(false)
    expect(notificationService.hasMore()).toBe(true)
  })

  it('gives partial events to the thread and stats services', async () => {
    await notificationService.start(ME)

    lastOnEvents()([e1], false)

    expect(threadService.addRepliesToThread).toHaveBeenCalledWith([e1])
    expect(stuffStatsService.updateStuffStatsByEvents).toHaveBeenCalledWith([e1])
  })
})
