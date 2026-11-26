# Skip Relays That Give No Answer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read to a relay that recently gave no answer ends at once; the memory survives a restart; the relay is re-checked in the background.

**Architecture:** `UnreachableRelays` (new, `src/lib`) decides; `ManagedRelay` asks it on subscribe and reports each connect attempt; `SmartPool` passes it through; Electron main's `RelayManager` turns it on with a JSON store in `userData`.

**Tech Stack:** TypeScript, nostr-tools `AbstractRelay`, Vitest (fake timers), Electron 45, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-26-unreachable-relays-design.md`

## Global Constraints

- Fork-only; PR with `gh pr create -R ChadFarrow/jumble --base master`. Never write to `CodyTseng/jumble`.
- `UNREACHABLE_AFTER_MS` = 8_000, sleep guard 15_000, `RECHECK_AFTER_MS` = 5 * 60_000, record TTL 30 days, max 500 records.
- Skip reason exactly `relay connection skipped: no answer recently`.
- Without the `unreachableRelays` option, `SmartPool` and `ManagedRelay` behave exactly as upstream (existing specs pass unchanged).
- Every Electron run gets `--mute-audio`; real-app tests send REQs only, never COUNT to `podtards.com`, never publish.
- `npm test`, `npm run lint`, `npm run build` pass.

## Review Focus

- A relay that works is marked after sleep/wake or a network change (guard: another handshake during the attempt; 15 s sleep guard; offline; online event re-check).
- A REQ is closed by its caller before the skip microtask: no late `oneose`/`onclose`.
- `RelayManager.subscribe` stores the closer after `subscribe()` returns: a synchronous `onclose` would leave a stale entry.
- A corrupt, partial or hostile `unreachable-relays.json` (wrong types, huge) does not crash main.
- Publish and auth to a marked relay still connect, and a success clears the mark.

---

### Task 1: `UnreachableRelays` and the `ManagedRelay` / `SmartPool` hooks

**Files:**

- Create: `src/lib/unreachable-relays.ts`, `src/lib/unreachable-relays.spec.ts`
- Modify: `src/lib/managed-relay.ts` (constructor 6th param `reachability?`, `subscribe`, `connect`), `src/lib/smart-pool.ts` (option `unreachableRelays?`, `getRelay`, `setNetworkOnline`)

**Interfaces (produces):**

- `type ConnectAttemptOutcome = { ok: boolean; startedAt: number; endedAt: number; networkOnline: boolean }`
- `type RelayReachability = { readDecision(url: string): { reason: string; recheck: boolean } | undefined; attemptEnded(url: string, outcome: ConnectAttemptOutcome): void }`
- `type UnreachableRelayStorage = { load(): unknown; save(records: Record<string, { markedAt: number; checkedAt: number }>): void }`
- `class UnreachableRelays implements RelayReachability { constructor(storage?: UnreachableRelayStorage, now?: () => number); networkChanged(online: boolean): void; has(url: string): boolean }`
- `SmartPoolOptions.unreachableRelays?: UnreachableRelays`

- [ ] **Step 1: failing tests** (`unreachable-relays.spec.ts`, real `SmartPool` + `AbstractRelay` over a fake WebSocket that can stay silent per URL, fake timers):
  - skips a read at once after a relay gave no answer and the caller closed its REQ at 10 s (no new socket; `oneose` then `onclose` with the skip reason; another relay handshook meanwhile)
  - marks after a 10 s connect timeout on a long-lived REQ
  - does not mark after a fast refusal
  - does not mark when no other relay completed a handshake during the attempt
  - does not mark while offline; does not mark an attempt longer than 15 s
  - keeps the mark across a restart (shared storage, new pool)
  - re-checks in the background after 5 min while the read still ends at once; a relay that answers is used again
  - a failed re-check keeps skipping without a new socket until the next 5 min
  - the online event makes the re-check due at once
  - publish still connects to a marked relay, and its success clears the mark
  - a skipped REQ closed before the microtask fires nothing
  - storage: corrupt / malformed input counts as empty; drops records older than 30 days; keeps at most 500
- [ ] **Step 2:** run `npx vitest run src/lib/unreachable-relays.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** implement per the spec's Design section.
- [ ] **Step 4:** run the spec, then `npx vitest run src/lib` — Expected: all PASS, existing `smart-pool.spec.ts` and `managed-relay.spec.ts` unchanged and green.
- [ ] **Step 5:** commit.

### Task 2: Electron store, wiring, real-app check, notes

**Files:**

- Create: `electron/main/unreachable-relays-store.ts` (`createUnreachableRelayStorage(getFilePath: () => string): UnreachableRelayStorage`), its spec in `src/__tests__/unreachable-relays-store.spec.ts`
- Create: `scripts/fork/e2e-unreachable-relays.mjs`
- Modify: `electron/main/relay-manager.ts` (pass `unreachableRelays`), `CLAUDE.md` (fork feature, test line, the stale nos.lol cold-start note)

- [ ] **Step 1: failing store tests:** missing file → `undefined`; save then load round-trips; corrupt JSON → `undefined`; save writes atomically (no temp file left); a save error does not throw.
- [ ] **Step 2:** run — Expected: FAIL (module missing).
- [ ] **Step 3:** implement; wire `RelayManager` with `() => path.join(app.getPath('userData'), 'unreachable-relays.json')`.
- [ ] **Step 4:** run the store spec and `npm test` — Expected: PASS.
- [ ] **Step 5: real app** — `scripts/fork/e2e-unreachable-relays.mjs`: launch 1 (no store file) waits until the file names `JUMBLE_E2E_DEAD_RELAY` (default `wss://nos.lol/`, must give no answer from the test machine); launch 2 measures that every REQ to that relay settles in < 200 ms and the notification REQ starts < 3 s after the reload (was ~10 s). Run it — Expected: PASS.
- [ ] **Step 6:** `npm run lint`, `npm run build`; update `CLAUDE.md`; commit.
