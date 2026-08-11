# Node's event loop, `await`, and the LSN race

## The model
- Node runs your JS on **one thread** with an **event loop**. Only one piece of JS runs at a time.
- A **synchronous** function runs start-to-finish with nothing else interleaving → no locks needed (unlike Go/Java).
- **`await` is a yield point**: it *pauses* the current function and hands the thread back to the event loop, which can then run *other* pending work. When the awaited thing resolves, your function resumes.

Bridge: two `onClick`/`fetch` handlers in a React app — while handler A `await`s a fetch, handler B's click gets processed. That interleaving is where UI state races come from.

## The rule
> Code **between two `await`s** is atomic. Code **split across an `await`** is not.

## The concrete race (why `nextLsn()` mints up front)
Two independent client requests hit the leader at ~the same time (A: `x=4`, B: `x=5`). Counter = 5.

**BAD — read now, bump later (`highestLsn + 1`, bump only at apply):**
```
A: lsn = 5+1 = 6
A: await replicate(A)     ← A pauses, thread free
B: lsn = 5+1 = 6          ← still 5! A never bumped → SAME LSN (collision)
B: await replicate(B)
A resumes → apply(x=4 @6)  counter→6
B resumes → apply(x=5 @6)  6 > 6? no → B silently dropped (but B got 200) 💥
```
Result: arbitrary winner + a lost write + two writes claiming slot 6 (breaks the total order).

**GOOD — `nextLsn()` = `++counter` (read+bump in one synchronous step):**
```
A: lsn = ++counter = 6    ← atomic, before any await
A: await replicate(A)
B: lsn = ++counter = 7    ← counter already 6 → B gets 7
```
Distinct, ordered LSNs. `apply` then does deterministic last-writer-wins (7 beats 6); nothing is silently dropped. Failed writes just leave a harmless gap.

The fix works because `++counter` finishes **before** the first `await`, so the event loop can't switch to B until A has already claimed its number.

## The "first K of N" wait (leader `replicate`) uses the same idea
Collecting acks from many in-flight calls, resolving once *enough* succeed or a timeout fires — with a `settled`/`finish` guard so only the first outcome wins. It's the frontend **fetch-vs-timeout race**: take whoever wins first, ignore the loser.

## Recall prompts
1. What does `await` actually do to the single thread?
2. Complete: "code between two awaits is ___; code split across an await is ___."
3. Walk the two-request LSN collision and say exactly why `nextLsn()` prevents it.
4. Why are LSN gaps after a failed write acceptable?
