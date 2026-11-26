// Fork (ChadFarrow/jumble): remember relays that give no answer, so reads to
// them end at once instead of waiting for the 10 s timeout. Design:
// docs/superpowers/specs/2026-11-26-unreachable-relays-design.md
//
// No browser or Node APIs: Electron main injects the storage.

/** An attempt with no open socket after this long counts as "no answer". */
export const UNREACHABLE_AFTER_MS = 8_000
/** Longer than 1.5 × the 10 s connect timeout: a timer delayed by system sleep. */
const SLEEP_GUARD_MS = 15_000
/** A read to a marked relay starts one background connect at most this often.
 * The first re-check of a new mark comes sooner, in case the mark was wrong. */
export const FIRST_RECHECK_AFTER_MS = 30 * 1000
export const RECHECK_AFTER_MS = 5 * 60 * 1000
/** An attempt that started before a network change, or this soon after it,
 * proves nothing about the relay. */
const NETWORK_SETTLE_MS = 10_000
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 500

export type ConnectAttemptOutcome = {
  /** The WebSocket opened. */
  ok: boolean
  startedAt: number
  endedAt: number
  networkOnline: boolean
}

export type ReadDecision = { recheck: boolean }

/** What ManagedRelay asks and tells. */
export type RelayReachability = {
  /** Undefined: read as usual. Otherwise end the read at once, with no
   * connection; `recheck` asks for one background connect. */
  readDecision(url: string): ReadDecision | undefined
  attemptEnded(url: string, outcome: ConnectAttemptOutcome): void
  has(url: string): boolean
}

type UnreachableRecord = { markedAt: number; checkedAt: number }

export type UnreachableRelayStorage = {
  load(): unknown
  save(records: Record<string, UnreachableRecord>): void
}

export class UnreachableRelays implements RelayReachability {
  private records?: Map<string, UnreachableRecord>
  private lastHandshakeAt = Number.NEGATIVE_INFINITY
  /** Marks whose next read starts a re-check (online event, network change). */
  private recheckNow = new Set<string>()
  private lastNetworkChangeAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly storage?: UnreachableRelayStorage,
    private readonly now: () => number = Date.now
  ) {}

  has(url: string): boolean {
    return this.getRecords().has(url)
  }

  readDecision(url: string): ReadDecision | undefined {
    const record = this.getRecords().get(url)
    if (!record) return undefined
    const now = this.now()
    const dueNow = this.recheckNow.delete(url)
    const wait = record.checkedAt === record.markedAt ? FIRST_RECHECK_AFTER_MS : RECHECK_AFTER_MS
    const age = now - record.checkedAt
    // A check in the future (clock set back, bad file) counts as due.
    if (!dueNow && age >= 0 && age < wait) return { recheck: false }
    // Count the check as done now, so parallel reads start only one.
    record.checkedAt = now
    this.save()
    return { recheck: true }
  }

  attemptEnded(url: string, outcome: ConnectAttemptOutcome) {
    const records = this.getRecords()
    if (outcome.ok) {
      this.lastHandshakeAt = Math.max(this.lastHandshakeAt, outcome.endedAt)
      if (records.delete(url)) this.save()
      return
    }

    const duringNetworkChange =
      this.lastNetworkChangeAt >= outcome.startedAt - NETWORK_SETTLE_MS
    const record = records.get(url)
    if (record) {
      // A failed check keeps the mark. One that met a network change proves
      // nothing: the next read checks again.
      if (duringNetworkChange) {
        this.recheckNow.add(url)
        return
      }
      record.checkedAt = Math.max(record.checkedAt, outcome.endedAt)
      this.save()
      return
    }

    if (!outcome.networkOnline || duringNetworkChange) return
    const duration = outcome.endedAt - outcome.startedAt
    if (duration < UNREACHABLE_AFTER_MS || duration > SLEEP_GUARD_MS) return
    // Mark only when another relay answered during this attempt: the network
    // worked, so the silence came from this relay or the path to it.
    if (this.lastHandshakeAt < outcome.startedAt) return

    records.set(url, { markedAt: outcome.endedAt, checkedAt: outcome.endedAt })
    this.prune()
    this.save()
  }

  /** Offline or online. After online, every mark gets its re-check on the
   * next read. */
  networkChanged(online: boolean) {
    this.lastNetworkChangeAt = this.now()
    if (online) this.recheckNow = new Set(this.getRecords().keys())
  }

  private getRecords(): Map<string, UnreachableRecord> {
    if (this.records) return this.records
    this.records = new Map()
    let data: unknown
    try {
      data = this.storage?.load()
    } catch {
      data = undefined
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [url, value] of Object.entries(data as Record<string, unknown>)) {
        if (!/^wss?:\/\//i.test(url) || !isRecord(value)) continue
        this.records.set(url, { markedAt: value.markedAt, checkedAt: value.checkedAt })
      }
    }
    this.prune()
    return this.records
  }

  private prune() {
    const records = this.records
    if (!records) return
    const oldest = this.now() - RECORD_TTL_MS
    for (const [url, record] of records) {
      if (record.checkedAt < oldest) records.delete(url)
    }
    if (records.size <= MAX_RECORDS) return
    const byCheck = Array.from(records).sort(([, a], [, b]) => a.checkedAt - b.checkedAt)
    for (const [url] of byCheck.slice(0, records.size - MAX_RECORDS)) records.delete(url)
  }

  private save() {
    if (!this.storage || !this.records) return
    try {
      this.storage.save(Object.fromEntries(this.records))
    } catch {
      // Best effort: the memory still works for this run.
    }
  }
}

function isRecord(value: unknown): value is UnreachableRecord {
  if (!value || typeof value !== 'object') return false
  const { markedAt, checkedAt } = value as Record<string, unknown>
  return Number.isFinite(markedAt) && Number.isFinite(checkedAt)
}
