# Design decisions

Status legend: **DECIDED** (built or being built) · **PLANNED** (later stage) · **LIMITATION** (known, accepted for now).

## One-sentence system summary

> Acknowledged writes are durable on a **majority** (W=2); reads from any single node (R=1) are **eventually consistent**, because `W + R` is not greater than `N`.

---

## 1. Stack & runtime — DECIDED
- **Node.js + TypeScript**, run with **node-native TS** (no `tsx`). Node strips types at runtime; we only use **erasable syntax** (`erasableSyntaxOnly: true` in tsconfig catches violations like class *parameter properties*, which Node can't run).
- Rationale: fewer moving parts, one runtime for dev/prod/Docker.

## 2. Client API: HTTP via Fastify — DECIDED
- Clients hit plain HTTP (`PUT/GET/DELETE /store/:key`, `GET /health`).
- Rationale: the grader hits us with `curl`; no reason to make graders speak gRPC.

## 3. Inter-node transport: gRPC — DECIDED
- Node-to-node RPCs (`Heartbeat`, `Replicate`, `Forward`, later `RequestVote`) over gRPC.
- Rationale: typed contract as the protocol grows, compact binary for constant chatter, first-class per-call **deadlines** (critical for Chaos Hour).
- Trade-off: setup friction (`.proto` + loader).

## 4. Topology: single-leader (master/slave) — DECIDED
- One node is the leader; all writes are ordered by it.
- Rationale: **one writer → a total order of writes → no write-write conflicts** (no vector clocks / CRDTs needed).

## 5. Leader selection — DECIDED (dynamic, Raft-lite)
- **Built:** dynamic **Raft-lite election** — followers run a randomized election timer; on leader silence a follower becomes a candidate, `term++`, and needs a **majority** (2/3) with the **up-to-date-log** rule to win. Validated end-to-end (kill leader → failover; minority → no split-brain; revive → recovery). See `notes/leader-election.md`.
- **Superseded:** the earlier static "smallest node id" rule (no failover). The `id@host:port` membership format it needed is still used — peers need stable ids to address each other and to record `leaderId`.
- Two safety/hygiene details caught in our own review (both fixed): a **stale-term vote** must not crown a candidate in a newer term (guard on `currentTerm === electionTerm`), and `RequestVote` now carries a per-call **deadline** like the other RPCs.

## 6. Consistency: hybrid W=2 / R=1 — DECIDED
- **Writes:** ack only after a **majority** holds it (leader + 1 follower for N=3). Durable across a leader crash.
- **Reads:** served from any one node (R=1), so they can be stale and converge later → **eventual**.
- `W + R = 3`, not `> N = 3` → eventual by design. Bump `R` to 2 for strong reads.
- CAP stance: during a partition, a leader that can't reach a majority **refuses** the write (CP on writes) rather than falsely acking.

## 7. Write path: routing, order, and the shared procedure — DECIDED
- **Routing:** a write may land on any node. A **follower forwards** it to the leader via the `Forward` gRPC RPC; the leader runs the write and returns a `WriteStatus` (`OK` / `NOT_FOUND` / `NO_MAJORITY_ACK`), which the follower maps back to HTTP (200 / 404 / 504).
- **One shared procedure:** the leader's write logic lives in a single `cluster.write(op)` — the authority owns it — called by *both* the leader's HTTP path and the `Forward` handler, so there is no duplication (see `notes/duplication-and-dry.md` for how a duplicated copy drifted before this).
- **Order (replicate-then-apply):** mint LSN → replicate to majority → **only then** apply locally + ack the client. The leader never holds/acks a write that isn't majority-durable.
- LIMITATION: followers apply **eagerly** on receipt (no separate commit-index round like full Raft), so a follower can briefly hold a not-yet-committed write. Leader is commit-safe; followers are eager.

## 8. Data model: in-memory versioned map — DECIDED
- `Map<string, Entry>` where `Entry = { value: string | null, lsn: number, deleted: boolean }`.
- `Map` (not object/array/tree): O(1) point ops, safe string keys, and the access pattern is exact-key only (no range scans).
- Each field is forced by a need: `value` (reads), `lsn` (order/merge writes), `deleted` (tombstone).
- **Deletes are tombstones**, not raw removals — otherwise a lagging replica or a resync could **resurrect** a key. Reads treat a tombstone as 404.

## 9. LSN allocation — DECIDED
- Monotonic counter. `nextLsn()` does `++counter` — **atomic allocation up front** (before any `await`), so concurrent writes get unique, ordered LSNs.
- Failed writes leave **gaps** in the sequence — harmless (LSNs must be unique + monotonic, not contiguous). Same trade-off as SQL `SEQUENCE`/`AUTO_INCREMENT` gaps after a rollback.
- Two distinct uses of the LSN: **per-key version** (stored on the entry; drives the `apply` accept/reject gate) vs **global high-water mark** (the counter; `Math.max(counter, lsn)` in `apply`, never `++`).

## 10. Persistence & recovery — DECIDED (WAL + resync)
- **Built (WAL):** per-node append-only log (`data/<nodeId>.wal`, one JSON `LogEntry` per line). Every applied write is appended inside `Store.apply()` — the single path all committed writes funnel through on every node (leader after majority-ack; followers in `Replicate`). On boot `load()` replays it, **reusing `apply()`**, so replay is idempotent/ordered for free and also **restores the LSN counter** (`Math.max`) so a restarted leader mints past its old max. `appendFileSync`, no per-write `fsync` (replication already gives cross-node durability). A `replaying` flag stops recovery feeding the log back into itself. Verified: a killed follower restarts and serves its data from RAM.
- **Built (resync / anti-entropy):** every heartbeat carries the leader's `highestLsn`; a follower that finds the leader **ahead** (it missed writes / is brand new) pulls a `Resync` and merges the leader's current state through `apply()`. Sends `fromLsn=0` → **full current state** (≈ keyspace, tombstones included), safe because `apply()` dedups by LSN. Self-limiting (after merge its LSN matches the leader's → no more pulls). Verified: a node **down during the writes** heals purely by rejoining, and persists what it pulled to its own WAL.
- LIMITATION: `fromLsn` is a hook for a future **delta**, but delta-by-highwater can skip an un-overwritten sub-highwater gap (`lsn=7` present, `lsn=5` missing) — full-state (`fromLsn=0`) avoids it. The highwater-comparison **trigger** also won't fire for an equal-highwater internal gap (rare; would need a digest/Merkle compare). See `notes/persistence-and-wal.md`.

## 11. Failure detection — DECIDED (tunable)
- Leader heartbeats every ~250ms; a peer is declared dead only after a **window** of silence (randomized election timeout, 1000–2000ms) — not on a single missed ping (avoids false positives). All via env.

## 12. Deployment — DECIDED (compose) / PLANNED (3 VMs)
- **Built:** `docker-compose.yml` runs the 3-node cluster from one env-differentiated image — peers via compose **service-name DNS** (`node2@node2:9080`), only HTTP published to the host (`8081–8083`), a **named volume per node** persists its WAL, and `restart: unless-stopped`. Chaos-validated in containers: `docker compose stop` the leader → failover to a new leader → writes continue; `start` it → recovers via its WAL volume **and** resync.
- **Planned:** the same image on **3 separate VMs** — per-VM env pointing `PEERS` at the other VMs' addresses, the gRPC port opened between them, one chaos sidecar per VM.

## 13. Observability: honest role in /health — DECIDED
- `/health` reports the node's real role via a read-only `cluster.roleName` getter (`follower | candidate | leader`), not a hard-coded "leader-or-follower". A read-only getter (not a public field) lets outside code observe the role while keeping mutation inside the election logic. Matters under chaos: a stuck candidate must show as a candidate, not be mislabeled a follower.

---

## Known limitations (say these out loud in the review)
- Followers apply eagerly → not full Raft commit semantics (see #7).
- Resync trigger uses an LSN high-water comparison → an equal-highwater *internal* gap wouldn't self-heal without a digest compare (rare; #10).
- LSN gaps on failed writes (intended, #9).
