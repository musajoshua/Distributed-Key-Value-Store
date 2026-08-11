# Leader election

## Where we are
- **Stage 2 (now): static leader** = the smallest node id, computed independently by every node from the shared membership set (`id@host:port`). All nodes reach the same answer with **zero coordination** — but only because they share an identical membership list. The moment liveness changes, a static rule isn't enough.
- **Stage 3 (planned): Raft-lite election** to pick a leader dynamically and fail over safely.

## Raft-lite building blocks (planned)
- **Roles:** every node is `Follower`, `Candidate`, or `Leader`.
- **Term (epoch):** a monotonically increasing integer; each election is a new term. Any message carries a term; **seeing a higher term → step down to Follower**. At most one leader per term (majority vote + one vote per node per term).
- **Heartbeats:** the leader pings every follower each `HEARTBEAT_MS` (~250); each heartbeat resets the follower's election timer.
- **Election timeout / window:** a **randomized** countdown (1000–2000ms). If it expires with no heartbeat, the follower becomes a Candidate. Randomized so two followers don't tie-vote repeatedly; several × the heartbeat so one dropped beat isn't a false trigger.

## The election
1. Candidate: `term++`, vote for self, send `RequestVote(term, lastLSN)` to peers.
2. A voter grants iff: term is new **AND** it hasn't voted this term **AND** the candidate's log is **at least as up-to-date** (`candidate.lastLSN >= my.lastLSN`).
3. Majority (2/3) → becomes Leader, starts heartbeating. Hears a valid leader / higher term → reverts to Follower.

## Why no split-brain
- A partition that isolates 1 node: it can only ever get **1 vote** (itself) → never a majority → never leader. The majority side elects normally → exactly one leader.
- An old leader that rejoins sees a higher term → steps down.

## The tie to W=2 durability (the up-to-date-log rule)
An acked write is on leader + 1 follower. The vote restriction means a node **missing** that write (smaller `lastLSN`) can't win, so the new leader always has every majority-acked write. **Election safety and write durability are the same mechanism from two angles.**

## Recall prompts
1. How is the static leader chosen, and why do all nodes agree without talking?
2. What is a *term*, and how does it kill split-brain?
3. State the vote-granting conditions — especially the log freshness rule.
4. Why can a minority-partition node never become leader?
5. How does the up-to-date-log rule protect a W=2 acknowledged write during failover?
