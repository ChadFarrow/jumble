# Notifications Without Waiting for the Slowest Relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The notification list shows each read relay's events when that relay answers, not after the slowest one.

**Architecture:** `NotificationService._start` already receives `onEvents(events, false)` after each relay's EOSE and drops it. Merge those partial results into the shown list (union, newest first); leave the final `eosed === true` path as it is.

**Tech Stack:** TypeScript, React 19, Vitest, Electron 45, Playwright `_electron` (playwright-core).

**Spec:** `docs/superpowers/specs/2026-11-26-notifications-no-wait-design.md`

## Global Constraints

- Fork-only: never write to `CodyTseng/jumble`; PR with `gh pr create -R ChadFarrow/jumble --base master`.
- Every Electron run gets `--mute-audio`. Real-app tests read relays only; they never publish (read-only npub account).
- No change to which relays are read, to the EOSE timeout (10 s) or to the public relay lists.
- `npm test`, `npm run lint` and `npm run build` pass (CI runs all three).

## Review Focus

- A fast relay returns only a few recent events while the saved list is longer and older: the list must keep the saved events (no shrink, no flash).
- The account changes while relays still answer: results for the old account are ignored.
- A partial result holds the account's own events: they are dropped, as in the final result.
- A partial result repeats events already shown: no duplicates.
- A relay answers with zero events (as `hist.nostr.land` does): the list and the listeners see no change.

---

### Task 1: Merge partial relay results in `NotificationService`

**Files:**
- Modify: `src/services/notification.service.ts` (`_start`, the `onEvents` handler)
- Test (create): `src/services/notification.service.spec.ts`

**Interfaces:**
- Consumes: `client.subscribeTimeline(subRequests, { onEvents, onNew }, opts)` — the test mock captures `onEvents(events: NostrEvent[], eosed: boolean)`; `client.getEventsFromIndexed(filter)`; `client.fetchRelayList(pubkey)`; `mergeTimelines` from `@/lib/timeline`.
- Produces: no new API. `getEvents()`, `getInitialLoading()`, `hasMore()`, `onDataChanged()` keep their meaning.

- [ ] **Step 1: Write the failing tests** — mock `./client.service` (`getEventsFromIndexed`, `fetchRelayList` → `{ read: [4 urls], write: [], originalRelays: [] }`, `subscribeTimeline` that stores the handlers and returns `{ closer: vi.fn(), timelineKey: 'k' }`), `./thread.service`, `./stuff-stats.service`. Build events with distinct `id`, `created_at`, `pubkey` (other author unless the test says own). Call `notificationService.stop()` in `afterEach`. Tests:
  - `shows a relay's events before the other relays answer`: after `start(pk)`, `onEvents([e3, e2], false)` → `getEvents()` ids `[e3, e2]`, `getInitialLoading()` true, `hasMore()` false, a data-changed listener was called.
  - `keeps saved notifications when a fast relay returns only a few`: stored `[s2, s1]` (older), `onEvents([e9], false)` → ids `[e9, s2, s1]`.
  - `does not duplicate events already shown`: stored `[s2, s1]`, `onEvents([s2], false)` → ids `[s2, s1]`.
  - `drops the account's own events from a partial result`: `onEvents([own, e1], false)` → ids `[e1]`.
  - `changes nothing for an empty partial result`: stored `[s1]`, listener reset, `onEvents([], false)` → ids `[s1]`, listener not called.
  - `ignores results for an account that is no longer current`: capture handlers, `stop()`, then `onEvents([e1], false)` → `getEvents()` empty.
  - `finishes loading when the last relay answers`: partial `[e2]`, then `onEvents([e3, e2], true)` → ids `[e3, e2]`, `getInitialLoading()` false, `hasMore()` true.
  - `gives partial events to the thread and stats services`: `onEvents([e1], false)` → `threadService.addRepliesToThread` and `stuffStatsService.updateStuffStatsByEvents` called with `[e1]`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/services/notification.service.spec.ts`
Expected: the partial-result tests FAIL (events stay empty / unchanged); the final-result test passes.

- [ ] **Step 3: Implement** — in the `onEvents` handler, after the own-event filter: when `!eosed`, return early if `filteredEvents` is empty; else `this.events = mergeTimelines([filteredEvents, this.events])`, call the two services with `filteredEvents`, `emitDataChanged()`. Do not touch `until`, `initialLoading` or `emitNewEvent`. The `eosed` branch stays unchanged.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/services/notification.service.spec.ts` then `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/notification.service.ts src/services/notification.service.spec.ts docs/superpowers
git commit -m "fix(notifications): show each relay's results without waiting for the slowest relay"
```

### Task 2: Real-app test and fork notes

**Files:**
- Create: `scripts/fork/e2e-notifications.mjs`
- Modify: `CLAUDE.md` (fork section: "Fork features" and "Tests")

**Interfaces:**
- Consumes: the dev app (`ELECTRON=true npx vite build --config vite.electron.config.ts` first); IPC channel names `relay:subscribe`, `relay:sub:event`, `relay:sub:eose`, `relay:sub:close` (`electron/shared/ipc-types.ts`); localStorage keys `accounts` and `currentAccount`.
- Produces: `node scripts/fork/e2e-notifications.mjs` → prints per-relay timings and PASS/FAIL lines, exit code 0 only when every check passes. Env: `JUMBLE_E2E_NPUB` (default Chad's npub), `JUMBLE_E2E_SLOW_RELAY` (default `wss://hist.nostr.land/`), `JUMBLE_E2E_SLOW_MS` (default 8000).

- [ ] **Step 1: Write the script** — launch with `--mute-audio`, a fresh `--user-data-dir` (realpath of a temp dir, deleted at the end), invisible click-through window, `shell.openExternal` stubbed. In main, wrap the `relay:subscribe` handler to tag the notification subscriptions (`#p` includes the pubkey and kinds include 9735) and wrap `webContents.send` so every `relay:sub:*` message of the slow relay's subscription is delayed by `JUMBLE_E2E_SLOW_MS`. Write the read-only npub account to localStorage, reload, open Notifications. Checks: (a) the slow relay's subscription exists; (b) the first notification shows before `JUMBLE_E2E_SLOW_MS − 2000` ms; (c) the loading bar of the visible list is still there at that moment and is gone after the slow relay answers; (d) the list is not shorter after the final result than before it.

- [ ] **Step 2: Run it on `master`'s service to see it fail** — `git stash` the Task 1 source change (or `git checkout master -- src/services/notification.service.ts`), rebuild the renderer, run the script.
Expected: check (b) FAILS (first notification ≈ 8 s).

- [ ] **Step 3: Restore Task 1, rebuild, run again**
Expected: all checks PASS; first notification in well under 2 s.

- [ ] **Step 4: Update `CLAUDE.md`** — one "Fork features" line for this behavior, one "Tests" line for the script and its env vars.

- [ ] **Step 5: Run `npm run lint` and `npm run build`, then rebuild the Electron renderer**
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/fork/e2e-notifications.mjs CLAUDE.md
git commit -m "test(fork): real-app test for notifications with a slow relay"
```
