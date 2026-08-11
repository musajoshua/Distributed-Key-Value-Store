# Replication & quorum

## N, W, R
- **N** = number of replicas. **W** = nodes that must ack a write. **R** = nodes read from.
- **`W + R > N` → strong** (the write-set and read-set must overlap by ≥1 node → any read sees the latest write; pigeonhole).
- **`W + R ≤ N` → eventual** (no guaranteed overlap; faster, more available).
- Ours: **W=2, R=1, N=3** → `2+1 = 3`, not `> 3` → eventual reads, majority-durable writes.

## Majority math
```
N = peers.length + 1
majority = floor(N / 2) + 1        (N=3 → 2, N=5 → 3)
followersNeeded = majority - 1     (leader already holds it)  (N=3 → 1)
```
Watch operator precedence: `floor((peers.length + 1) / 2) + 1`, NOT `floor(peers.length + 1/2) + 1`.

## Why wait for a *majority*, not all
- Waiting for **all** = `W = N`: one slow/dead follower blocks *every* write.
- Waiting for a **majority**: writes keep succeeding with one node down (leader + 1 of 2). Test quorum math with a node **down**, not just all-up — an "all" bug passes the happy path and only bites in Chaos Hour.

## CAP stance
If the leader can't reach a majority (e.g., partitioned into the minority), the write **fails** — we refuse rather than falsely ack a non-durable write. That's the CP choice on writes.

## The `replicate(entry)` pattern — "first K of N"
```
followersNeeded = majority - 1; if (<=0) return true
new Promise(resolve):
  acks=0, settled=false
  finish(v): if settled return; settled=true; resolve(v)   // only the first outcome wins
  for each peer: client.Replicate(entry, {deadline}, (err,reply) => {
      if (!err && reply.ok && ++acks >= followersNeeded) finish(true)
  })
  setTimeout(() => finish(false), timeout)                 // backstop → couldn't reach majority
```
- Fire **all** peers in parallel; count acks; resolve at the threshold.
- **Per-call deadline** (each call errors promptly) **+ overall timeout** (guarantees the promise settles).
- `settled` = the fetch-vs-timeout "ignore the loser" guard. (JS ignores a 2nd `resolve` anyway; the guard is for clarity + avoiding redundant side-effects.)

## Write path (replicate-then-apply)
```
PUT (leader):  mint lsn → build entry → await replicate → if !majority: 500
                                                       else: store.apply(entry) → 200
DELETE (leader): 404 if store.get(key) === null   // explicit null, not !value ("" is a valid value)
                 else mint lsn → tombstone entry (value:"", deleted:true) → replicate → apply → 200
followers (for now): 503 (forwarding to leader is the next step)
```
- Order matters: apply/ack only **after** majority → leader never holds a non-durable write.
- LIMITATION: followers apply eagerly on receiving `Replicate` (no commit-index round), so they can briefly hold a not-yet-committed write.

## Recall prompts
1. Derive `majority` and `followersNeeded` for N=3 and N=5.
2. Why wait for a majority instead of all followers? What test reveals the difference?
3. What does the `settled` guard do, and what's the frontend analogy?
4. Why 500 (not 200) when a majority can't be reached?
5. Why check `store.get(key) === null` and not `!value` in DELETE?
