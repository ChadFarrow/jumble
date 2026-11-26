# Notifications: show each relay's results without waiting for the slowest relay

Fork-only change (ChadFarrow/jumble). Approved by Chad on 2026-11-26 ("yes start step 1").

## Intent

Chad opens Jumble and waits for his notifications. Measured on 2026-11-26 in the dev
app, signed in read-only with his npub:

- the saved notifications (IndexedDB) show in about 0.1 s;
- the notifications from relays show only when **every** read relay has answered: 2 to
  4 s that day, once 10 s. `wss://relay.damus.io` failed three connection attempts each
  time, and the list waited for that (or for the 10 s EOSE timeout).

The cause is `NotificationService._start` (`src/services/notification.service.ts`): its
`onEvents` handler ignores every call with `eosed === false`. `subscribeTimeline`
already calls it after each relay's EOSE with the events so far, so the data is there
and is dropped.

## Goal

New notifications show as soon as the first read relay answers. A slow or dead relay
still adds its events when it answers, but it no longer holds back the others.

## Non-goals

- No change to which relays are read (that is step 2, after Chad's Haven review).
- No change to the public relay lists.
- No change to the 10 s EOSE timeout or to the relay connection code.

## Anti-goals

- The list must not shrink or flash while relays answer (for example, drop the saved
  notifications because one fast relay returned only a few recent events).
- No extra system notifications or unread bumps for events that are only being loaded.

## Approaches

1. **Merge partial results in `NotificationService` (chosen).** On `onEvents(events,
   false)`, merge the events into the list (a union with what is shown, newest first)
   and emit a data change. Keep `initialLoading` true and `until` unset until the last
   relay answers; the final step stays as it is. Small, local, and the list behaves the
   same as with saved notifications shown today.
2. Lower the wait: read fewer relays or a shorter EOSE timeout. Rejected: it hides data
   from a slow relay and changes behavior for every feed.
3. Show results after half the relays answer (the `threshold` logic that
   `subscribeTimeline` has for several requests). Rejected: with one slow relay out of
   four it still waits on the second-slowest, and it needs changes in shared code.

## Design

- `onEvents(events, eosed)` in `_start`:
  - both cases: drop the account's own events (as today);
  - `eosed === false` and events not empty: `this.events = mergeTimelines([filtered,
    this.events])` (dedupes the same event), pass the events to
    `threadService.addRepliesToThread` and `stuffStatsService.updateStuffStatsByEvents`
    (both skip events they already have), then `emitDataChanged()`. No
    `emitNewEvent`, so no system notification;
  - `eosed === true`: unchanged (`mergeWithStored`, `until`, `initialLoading = false`).
- The loading bar stays until the last relay answers, as today.

## Tests

- Unit (`src/services/notification.service.spec.ts`, client and stats services mocked):
  partial results show at once; saved notifications stay when a partial result is
  short; `initialLoading` and `hasMore()` change only at the final result; own events
  are dropped; a result for an account that is no longer current is ignored.
- Real app (`scripts/fork/e2e-notifications.mjs`): a fresh data folder, Chad's npub
  read-only, the real relays; the main process holds one relay's answer back for 8 s.
  Before the change the first notification shows after about 8 s; after it, in about
  the time of the fastest relay.

## Left to the builder

Names of helpers and test files; the exact delay and limits in the real-app test.
