# Ignore "no permission" From Another Signer of the Same Key — Design

Fork-only (ChadFarrow/jumble, "Jumble Chad"). Chad chose this fix on 2026-11-26
("2", over removing Amber connections), and said he uses only Clave in Jumble
Chad, not Amber.

## Why

Chad's Clave (iOS) and Amber (Android) both hold his key, and both answer
NIP-46 requests to it. Clave signs NIP-46 messages with the user key, so the
remote signer pubkey is the same for both. Amber listens on `relay.ditto.pub`
and `relay.powr.build` (the QR's relays and Clave's bunker relay). For an app
that it has no connection with, Amber answers every request with the error
`no permission` (`NIP46_NO_PERMISSION` in Amber's `Nip46Admission.kt`), about
130–200 ms before Clave answers. nostr-tools' `BunkerSigner` takes the first
answer, so the QR login and the bunker:// login both failed with
"no permission. Please reload.", and each later request would fail the same way.

Measured 2026-11-26 with an unpaired test request to Chad's key: Amber answered
`no permission` after 397 ms (ditto) and 658 ms (powr.build); Clave answered
`Client not paired …` after 530 ms and 857 ms.

## Design

`Nip46Pool` takes an optional client secret key (third constructor argument).
With it, the pool decrypts each kind 24133 event before it reaches nostr-tools
and drops a response whose `error` is exactly `no permission`, or exactly
`invalid secret` (Amber's answer to a bunker `connect` whose secret it does not
know, `connectSecretRejection` in Amber's `Nip46Requests.kt`; found in the
review) (`src/lib/nip46-unknown-refusal.ts`). The request then waits for the
next answer, or fails on its normal timeout: 10 s for a bunker:// login
("Bunker connect timeout", and its first get_public_key), 30 s (nostr-tools' default) for other requests. An event it
cannot decrypt or parse is passed on unchanged. `NostrConnectionSigner` (QR) and
`BunkerSigner` (bunker://, also a restored login) pass their client key.

## Costs

- An app that Amber really does not know (or has revoked), with Amber as its
  only signer, gets a timeout instead of the error at once. A wrong secret in a
  bunker:// link for Amber also ends in the 10 s timeout. Chad does not use
  Amber in Jumble Chad.
- Only those exact texts are dropped. Other errors (`user rejected`, Clave's
  `Client not paired …` and `Invalid or missing secret`) still end the request
  at once.

## Not done

- No change to nostr-tools, to Amber or to Clave.
- No wait for a second answer after other errors.
