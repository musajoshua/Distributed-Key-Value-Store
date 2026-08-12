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

## 5. Leader selection — DECIDED (static) / PLANNED (dynamic)
- **Now:** static — leader = **smallest node id** computed from the shared membership set. Every node computes the same answer with zero coordination (works only because all share one id list). Requires one id namespace, so `PEERS` is `id@host:port`.
- **Stage 3:** replace with **Raft-lite election** (see `notes/leader-election.md`).
- LIMITATION: id comparison is lexicographic (`"node10" < "node2"`). Fine for `node1/2/3`.

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

## 10. Persistence & recovery — PLANNED (Stage 4)
- Per-node append-only log (WAL); LSN = the log position.
- Recovery = replay own log, then **delta resync** from the leader ("send me everything after my highest LSN"); snapshot fallback if too far behind.

## 11. Failure detection — DECIDED (tunable)
- Leader heartbeats every ~250ms; a peer is declared dead only after a **window** of silence (randomized election timeout, 1000–2000ms) — not on a single missed ping (avoids false positives). All via env.

## 12. Deployment — PLANNED (hybrid)
- **docker-compose** (3 nodes + chaos agent) as the graded artifact.
- **3 separate VMs** for realism (same image, env-configured peers, one chaos sidecar per VM).

---

## Known limitations (say these out loud in the review)
- Followers apply eagerly → not full Raft commit semantics (see #7).
- Static leader has no failover yet → Stage 3 election fixes it (#5).
- Lexicographic id comparison (#5).
- No persistent log yet → a full-cluster restart loses data until Stage 4 (#10).
- LSN gaps on failed writes (intended, #9).
