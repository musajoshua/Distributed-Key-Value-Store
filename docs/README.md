# Project docs

Reference material for this distributed key-value store — the **why** behind the design, and notes on the concepts learned while building it.

## Structure

- **`design-decisions.md`** — every architectural decision, with rationale, status, and trade-offs.
- **`plan/`** — the full staged walkthrough plan (copied from Cursor).
- **`notes/`** — concept notes, written to be re-read. Each ends with **Recall prompts** you can use to self-test (close the note and try to answer them).
  - `grpc.md` — gRPC vs REST, protobuf, the `.proto` contract, and how it maps to our code.
  - `store-lsn-and-convergence.md` — the in-memory store, LSNs, tombstones, and `apply` convergence.
  - `async-and-concurrency.md` — Node's event loop, `await` yield points, and the LSN-collision race.
  - `replication-and-quorum.md` — N/W/R, majority math, and the replicate-then-apply write path.
  - `leader-election.md` — static leader today; Raft-lite (terms, votes, heartbeats) planned for Stage 3.

## How to use these

- Read `design-decisions.md` first for the big picture.
- Use the notes for the mechanics; they follow the flow: concept → intuition → concrete example → trade-offs.
- The **Recall prompts** are the point — the value is being able to answer them without looking.
