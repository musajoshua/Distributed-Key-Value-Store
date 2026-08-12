# Leader election

## Where we are
- **Built: Raft-lite election** — the leader is chosen dynamically and fails over safely; validated under chaos. It superseded the earlier static "smallest node id" rule, which had zero coordination cost but **no failover**.

## Raft-lite building blocks
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

## Bugs we caught reviewing our own election (both fixed)
1. **Stale-term crowning (safety).** The win guard checked `role == 'candidate'` but not the term, so a candidate that had already moved to term N+1 could be crowned by a *late* "yes" from term N. Fix: snapshot `const electionTerm = currentTerm` per election and require `currentTerm === electionTerm` before `becomeLeader()`. Why it matters: "majority ⇒ one leader" only holds if every counted vote is from the **same** term.
2. **RequestVote had no deadline (hygiene).** Every other outbound RPC bounds its wait; this one didn't, so a *hung* peer left a dangling call. Not a safety/liveness bug (the election timer re-fires), just a leak + inconsistency. Fix: `{ deadline: electionTimeoutMinMs }` — a vote is worthless past the next election anyway.

## Validated (chaos)
- Kill leader → a follower wins a new term → writes resume; the committed key is still readable (up-to-date-log rule).
- Kill a majority (2/3) → the lone survivor stays a **candidate** forever, never leader, writes → 503. No split-brain.
- Revive a node → majority returns → the stuck candidate wins → writes resume.
- `/health` now reports `candidate` honestly (previously masked as `follower`).

## Recall prompts
1. How is the static leader chosen, and why do all nodes agree without talking?
2. What is a *term*, and how does it kill split-brain?
3. State the vote-granting conditions — especially the log freshness rule.
4. Why can a minority-partition node never become leader?
5. How does the up-to-date-log rule protect a W=2 acknowledged write during failover?
6. Why is `role == 'candidate'` not enough to safely crown a winner — what else must the guard check, and what breaks without it?
