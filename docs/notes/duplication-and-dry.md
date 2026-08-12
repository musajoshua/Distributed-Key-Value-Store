# Duplication drift → DRY (learned the hard way)

## What happened
Building follower write-forwarding, I first implemented it **with the write procedure duplicated on purpose** — once in the leader's HTTP path, once in the gRPC `Forward` handler — so I'd *feel* the problem instead of being told about it.

Within a single sitting, the two copies **drifted**:

```
DELETE a missing key, directly on the leader   -> 404  (its copy had the existence check)
DELETE a missing key, forwarded from a follower -> 200  (the Forward copy had silently dropped it)
```

Same operation, two different answers — because two copies of "the write procedure" had already diverged.

## The fix
Extract the whole procedure into one method — `cluster.write(op)` — that **both** call sites invoke (the leader's HTTP handler and the `Forward` handler). The existence check now lives in exactly one place, so:

```
DELETE missing (direct)    -> 404
DELETE missing (forwarded) -> 404   ← same answer; the drift is now impossible
```

## The principle (earned, not asserted)
- **Duplicated logic doesn't stay in sync — it drifts, fast and silently.** I watched it happen in one sitting.
- **Extract the shared *procedure* to its owner** (here: the authority = the leader / `cluster`); leave only the **I/O formatting** at each edge (HTTP `reply.code(...)` vs gRPC `callback(...)`).
- The extraction boundary = *what stays identical across the copies* (the write steps) vs *what legitimately differs* (the response tail).

## Bridge
Same reason you keep controllers/BFF thin and put business logic in the service: the gateway/front-door proxies; the service owns the logic. A follower is the gateway; the leader is the service; `write()` is the service's business logic.

## Recall prompts
1. What concrete symptom revealed the two copies had drifted?
2. Where does the shared procedure belong, and what is allowed to stay at each call site?
3. Why is "extract into one method" a *structural* fix (drift becomes impossible), not just tidiness?
