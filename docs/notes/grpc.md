# gRPC (first time working with it)

## The problem it solves
Nodes on different machines need to call each other. By hand over raw TCP you'd invent framing, serialization, request/response matching. gRPC does all of that.

## REST vs RPC — the mental model
- **REST** (what I know): think in **resources + HTTP verbs on URLs**; you *construct* a request (method, path, JSON body) and parse a JSON response.
- **RPC** (gRPC): think in terms of **calling a function** that happens to run on another machine — `client.Heartbeat(req)` reads like a local call; the framework hides the network.
- Bridge: it's `fetch('/api/x', {...})` (hand-built request) vs. a generated, typed SDK method `api.heartbeat(req)`.
- Speed (binary + HTTP/2) is a **consequence**, not the defining difference. The defining difference is the abstraction.

## gRPC = 3 parts
| Part | What | REST analogy |
|---|---|---|
| `.proto` contract | declares the callable methods + message shapes | OpenAPI spec / a shared DTO — but it *generates* the calling code |
| Protocol Buffers | compact **binary** wire format | JSON, but smaller/faster |
| HTTP/2 | the transport | HTTP/1.1 |

Stack: `your call → protobuf bytes → HTTP/2 → TCP`.

## The `.proto` file
```proto
service Cluster { rpc Heartbeat (HeartbeatRequest) returns (HeartbeatReply); }
message HeartbeatRequest { string nodeId = 1; }
```
- `service` = a group of callable methods. `rpc Name (Req) returns (Reply)` = one unary method.
- `message` = a struct. Each field has a type, a name, and a **field number**.
- **Field numbers are wire tags, not values.** protobuf serializes `[number][value]` pairs, not names. So numbers must be unique per message and **stable across versions** (renaming a field but keeping its number stays compatible; changing the number breaks it).

## How it maps to our code (the 4 touchpoints)
1. **contract** → `proto/kv.proto`.
2. **generate the "SDK"** → `protoLoader.loadSync` + `grpc.loadPackageDefinition` → `ClusterService` (dynamic, no codegen step). It's both a client constructor and a server-registration handle.
3. **endpoint (server)** → `server.addService(ClusterService.service, { Heartbeat: (call, cb) => cb(null, reply) })`. `call.request` is the incoming message; `cb(err, reply)` is how a unary handler replies.
4. **the call (client)** → `new ClusterService('host:port', creds)` then `client.Heartbeat(req, {deadline}, cb)`.

## Why gRPC between nodes but HTTP for clients
- Nodes: constant chatter (heartbeats every 250ms, a replicate per write) → typed contract + binary + per-call deadlines earn their keep.
- Clients: the grader uses `curl` → HTTP.

## Recall prompts
1. In one line, what's the core difference between the REST and RPC mental models?
2. What is a protobuf **field number**, and why must it stay stable?
3. Name the 4 places gRPC shows up in our code and what each does.
4. Why did we keep the client API on HTTP but use gRPC between nodes?
