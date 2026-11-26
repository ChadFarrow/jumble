# Skip Relays That Give No Answer — Design

Fork-only (ChadFarrow/jumble, "Jumble Chad"). Approved by Chad on 2026-11-26
("yes go ahead with both"), after the plan in the topic chat.

## Why

`wss://nos.lol/` (and `wss://nostr.mom/`, same server) give no TCP answer from
Chad's home network; from other countries they answer in under 0.25 s. nos.lol is
in `BIG_RELAY_URLS`, so on every cold start the relay-list (10002) and profile (0)
requests wait for it until the 10 s EOSE timeout, and the notification REQ starts
about 10 s late. Profile fetches for unseen people wait the same way.

## Goal

A read (REQ) to a relay that recently gave no answer ends at once, with no
connection attempt, so nothing waits for it. The memory survives a restart. A
relay that answers again is used again.

## Non-goals and anti-goals

- No change to Chad's relay lists, published or local, and no change to Haven.
- No change to publish or auth: `publishEvent` already succeeds after a third of
  the relays accept, so a dead relay never blocks a post, and a post should still
  reach every relay that can take it.
- Anti-goal: a relay that works (for example Chad's Haven, `podtards.com`) is
  skipped after a laptop-style sleep/wake or a network change. Guarded below.
- Anti-goal: a mark that expires overnight, so the morning cold start waits again.
- No change to the web build or the background runner: only the Electron main
  `RelayManager` turns the feature on.

## Approaches

1. **Remember unreachable relays in the pool (chosen).** Skip reads to a marked
   relay; re-check it in the background. Covers nos.lol, nostr.mom and relays in
   other people's lists, with no list edits.
2. Remove nos.lol from the fork's `BIG_RELAY_URLS` / defaults. Fixes only the
   relays named today, and other users' relay lists still name nos.lol.
3. Stop waiting for all relays on replaceable/profile fetches. Touches every
   fetch path in `client.service.ts` and can show stale profiles.

## Design

New `src/lib/unreachable-relays.ts` (`UnreachableRelays`), small hooks in
`ManagedRelay`, `SmartPool` and `RelayManager`, and a JSON store in Electron main.

**What marks a relay.** A connection attempt that had no open socket after
`UNREACHABLE_AFTER_MS` = 8 000 ms: a connect timeout (10 s) or an abort after 8 s
or more. One attempt is enough. (A one-shot fetch closes its REQ at the 10 s EOSE
timeout; that aborts the connect and drops the `ManagedRelay`, so its
three-attempt counter never reaches 3 for nos.lol.) Not marked:

- a fast failure (refused, DNS, HTTP 503 as relay.damus.io gives): it costs
  about 3 s with the existing retries, and it is often short-lived;
- an attempt longer than 15 s (`1.5 × 10 s`, the existing sleep guard);
- an attempt while the pool is offline;
- an attempt during which no other relay completed a handshake (the network was
  not shown to work).

**What a mark does.** `ManagedRelay.subscribe` asks `readDecision(url)`. For a
marked relay it settles the REQ in a microtask, EOSE then close, with the reason
`relay connection skipped: no answer recently` (a transport failure, so the
renderer records no read rejection), and opens no socket. A `close()` before the
microtask silences it.

**Re-check.** A read to a marked relay whose last check is `RECHECK_AFTER_MS` =
5 min old or more still ends at once, and also starts one background connect
(`withRelay` with an empty operation). Success clears the mark; failure re-arms
it. The online event (`setNetworkOnline(true)` after offline) makes every
re-check due now. So a mark never expires into a wait.

**What clears a mark.** Any completed handshake to that relay: a re-check, a
publish or an auth.

**Persistence.** `UnreachableRelays` takes an optional storage `{ load, save }`.
Electron main stores `unreachable-relays.json` in `userData` (atomic write: temp
file, then rename). Load is lazy. A missing, corrupt or malformed file counts as
empty. Records not checked for 30 days are dropped; at most 500 records are kept
(oldest check dropped first).

## Calls made for Chad (rulings)

- The trigger is one slow attempt, not three attempts (the counter cannot reach 3
  for one-shot fetches).
- The 30 minutes told to Chad became a 5-minute background re-check that never
  makes a request wait; a mark has no expiry that brings the wait back.
- Reads only; publish and auth still try a marked relay.
- Fast failures (Damus 503) are not marked.
