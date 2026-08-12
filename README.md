# Distributed Key-Value Store

A from-scratch, in-memory, replicated key-value store that stays available and loses no acknowledged data when a node dies — built for **Build It, Break It, Fix It**. Node.js + TypeScript (run natively, no build step); **HTTP** for clients, **gRPC** between nodes.

## Consistency model (one sentence)

> Acknowledged writes are durable on a **majority** (`W=2` of `N=3`); reads are served from any single node (`R=1`) and are **eventually consistent**, because `W + R` is not greater than `N`.

## Replication strategy (one paragraph)

Single-leader, majority-ack replication. A dynamically **elected** leader (Raft-lite: terms, randomized election timeouts, majority vote gated by an up-to-date-log rule) assigns every write a monotonic **LSN**, giving a total order with no write-write conflicts. A write is replicated to all peers but is applied on the leader and acknowledged to the client **only after a majority** holds it (leader + 1 follower); the remaining replica converges asynchronously. **Any** node accepts client writes — a follower transparently **forwards** to the leader over gRPC. Deletes are versioned **tombstones**, never raw removals, so a lagging replica can't resurrect a key. Durability and recovery: each node appends every applied write to a per-node **write-ahead log** and replays it on restart; a node that fell behind while down (or a brand-new node) **resyncs** the leader's current state on rejoin — triggered by comparing the leader's high-water LSN, which it advertises in every heartbeat.

## Run it

### Docker (recommended)

```
docker compose up --build          # node1/2/3 → host ports 8081 / 8082 / 8083
curl localhost:8081/health
docker compose down                # add -v to also wipe the WAL volumes
```

`docker compose up node1 node2 node3` starts just the nodes (skips the organizer's chaos-agent image).

### Without Docker

Requires **Node 24+** (runs TypeScript natively — no build step).

```
npm ci
NODE_ID=node1 HTTP_PORT=8081 GRPC_PORT=9081 \
  PEERS=node2@127.0.0.1:9082,node3@127.0.0.1:9083 npm start
# node2 → 8082/9082, node3 → 8083/9083, each PEERS-pointed at the other two
```

## API

```
PUT    /store/:key   {"value":"..."}   → 200 {lsn} | 404 | 503 | 504
GET    /store/:key                     → 200 {"value":"..."} | 404
DELETE /store/:key                     → 200 {lsn} | 404
GET    /health                         → 200 {status,nodeId,nodes,role}
```

- `503` = no reachable leader (retry); `504` = couldn't reach a majority.
- `api.http` (VS Code / Cursor **REST Client** extension) has ready-to-send requests.

## Chaos & recovery

```
docker compose stop node1     # drop the leader → the cluster elects a new one
docker compose start node1    # it rejoins → recovers via its WAL volume + resync
```

The mandatory **chaos-agent** sidecar is wired into `docker-compose.yml` on `:9090` for the organizer.

## Known limitations

- Followers apply **eagerly** (no separate commit-index round) — the leader is commit-safe, but a follower can briefly hold a not-yet-committed write.
- Reads are `R=1` → **eventual**: an immediate read from the one replica we didn't wait for can be briefly stale.
- The resync **trigger** compares LSN high-water marks, so a rare equal-highwater *internal* gap wouldn't self-heal without a digest/Merkle compare.
- **Asymmetric** partitions (A↔B, B↔C, but not A↔C) are not explicitly handled.
- Small fixed cluster (`N=3`) assumed; node ids compared by value.

## Design docs

- `docs/design-decisions.md` — every architectural choice with rationale, status, and trade-offs.
- `docs/notes/` — concept notes (gRPC, LSN/convergence, replication/quorum, leader election, persistence/WAL, concurrency, DRY) each ending in **recall prompts**.
