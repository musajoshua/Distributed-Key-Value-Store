# Persistence & recovery (WAL)

## The problem (seen live)
Kill a node and its `Map` dies with the process — in the chaos test a revived node returned 404 for keys written before it left. In-memory state has to survive a restart.

## The WAL (built)
- **Per-node append-only log**: `data/<nodeId>.wal`, one JSON `LogEntry` per line (`{key,value,lsn,deleted}`).
- **One insertion point**: append inside `Store.apply()` — the single method every committed write funnels through (leader after majority-ack; followers in the `Replicate` handler). One line there persists all state, everywhere.
- **Append only on real changes**: it lives in `apply()`'s accept branch, so stale/duplicate entries (which `apply` rejects) never hit disk — the log stays minimal and correct.
- **Durability knob**: `appendFileSync`, no per-write `fsync`. A hard crash can lose OS-buffered lines, but replication already gives cross-node durability. Cheap + correctly ordered.

## Recovery (built)
- `load()` on boot reads the file and replays each line back through `apply()`.
- Reusing `apply()` is the trick: it's already idempotent + LSN-ordered, and `Math.max(lsnCounter, lsn)` **restores the counter** — so a restarted *leader* mints LSNs past its old max instead of colliding from 0.
- A `replaying` flag suppresses the append during `load()`, or recovery would feed the log back into itself.
- Ordering: `store.load()` runs **before** `cluster.listen()` / serving, so both the data and `highestLsn` (which voting relies on) are correct before the node participates.

## Resync: healing a node that missed writes (built)
- The WAL recovers only what a node **itself saw**; a node **down during writes** never logged them. Resync fills that in.
- **Trigger:** the leader stamps its `highestLsn` on every heartbeat; a follower that sees the leader ahead pulls a `Resync`.
- **Transfer:** `fromLsn=0` → the leader's **full current state** (one entry per key, tombstones included). The receiver runs each through `apply()`, which dedups by LSN — gaps fill, newer wins, re-running is safe. Self-limiting: after merging, the follower's LSN matches the leader's → no more pulls. What it pulls is also appended to its own WAL, so it's restart-safe afterward.
- **Why full state, not a delta:** a delta "after my highwater" can skip an un-overwritten sub-highwater gap (`lsn=7` present, `lsn=5` missing). `fromLsn` stays as the hook for a real delta later (needs a per-follower index or a digest compare).
- Verified: kill a follower, write while it's down, restart it → it serves data it never received, healed purely by rejoining.

## Recall prompts
1. Why put the append inside `apply()` and not in `put`/`delete` or the HTTP handler?
2. What does the `replaying` flag prevent, concretely?
3. Besides the data, what else does replay restore — and why does a restarted *leader* need it?
4. Why doesn't WAL replay heal a node that was down during writes? What does?
