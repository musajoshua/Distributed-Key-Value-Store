# The store, LSNs, tombstones, and convergence

## Why the store looks the way it does
Start from the problem: a node must remember key→value **and** participate in replication where writes arrive over a network (late, out of order, retried), and deletes must propagate.

- **Container = `Map<string, Entry>`.** Not a plain object (prototype-pollution, string-coerced keys), not an array (O(n) lookup), not a tree (we have no range queries). `Map` = O(1) point ops, safe keys.
- **Per-key record `Entry = { value, lsn, deleted }`.** Each field is forced:
  - `value` — to answer reads.
  - `lsn` — a **version** so we can order/merge writes (decide "is this newer than what I have?").
  - `deleted` — represent a delete as data (a **tombstone**), not a raw removal.
- **A class** (not a bare Map) so invariants (LSN monotonic, delete = tombstone, apply only accepts newer) live in one place.
- "Low-level" is deliberate: a normal KV library *hides* versions/tombstones because it does replication for you. Here **we** own replication, so we must expose that metadata — it *is* the distributed logic.

## LSN = Log Sequence Number
- A monotonically increasing number that **versions** every write/delete. The leader mints them.
- Relationship to a WAL: the LSN is the *position/id of an entry in* a write-ahead log (like a line number in a file, or a Kafka offset). The term comes from WAL systems (Postgres/SQL Server).
- **Two distinct uses** (do not merge them):
  - **per-key version** — stored on the entry; drives accept/reject.
  - **global high-water mark** — one counter per node = highest LSN seen. In `apply` it's `Math.max(counter, lsn)`, **never `++`** (a follower is *recording* the leader's number, not minting a new one).

## `apply(entry)` — the convergence primitive
```
accept iff (key absent) OR (entry.lsn > current.lsn)
  → store { value, lsn, deleted }; counter = max(counter, entry.lsn); return true
else → ignore; return false
```
This one rule gives:
- **Idempotency** — re-sending the same entry is a no-op (`lsn == current` fails `>`), so retries are safe.
- **Order-independence (convergence)** — if `lsn 9` then `lsn 5` arrive, `5` is rejected; if `5` then `9`, both considered but you still end at `9`. Either order → same final state. This is what makes "eventual consistency" actually converge.

## Tombstones (why delete ≠ `map.delete`)
If delete just removed the key, a replica that missed the delete would still serve it, and a resync could **resurrect** it. So a delete writes a versioned tombstone (`deleted: true`, its own LSN) that replicates like any write; reads treat it as 404. A later PUT resurrects the key only because it gets a **higher** LSN than the tombstone.

## Recall prompts
1. Why a `Map` and not an object, array, or tree?
2. Why does each of `value`, `lsn`, `deleted` exist?
3. State the `apply` rule, and explain how it delivers idempotency *and* convergence.
4. Why is a delete a tombstone, and what bug does that prevent?
5. What are the *two* uses of the LSN, and why is `apply` `Math.max` and not `++`?
