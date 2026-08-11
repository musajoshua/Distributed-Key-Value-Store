import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Peer } from '../config.ts';
import type { Store } from '../store.ts';

type Logger = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

const PROTO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../proto/kv.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  defaults: true,
  oneofs: true,
  enums: String
});
const grpcObject = grpc.loadPackageDefinition(packageDefinition) as any;
const ClusterService = grpcObject.kv.Cluster;

interface PeerState {
  peer: Peer;
  client: any;
  lastSeen: number;
  alive: boolean;
}

export class Cluster {
  private config: Config;
  private store: Store;
  private log: Logger;
  private server: grpc.Server;
  private peers: PeerState[];
  private timer?: ReturnType<typeof setInterval>;

  constructor(config: Config, store: Store, log: Logger) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.server = new grpc.Server();
    this.peers = config.peers.map((peer) => ({
      peer,
      client: new ClusterService(`${peer.host}:${peer.port}`, grpc.credentials.createInsecure()),
      lastSeen: 0,
      alive: false,
    }));
  }

  async listen(): Promise<void> {
    this.server.addService(ClusterService.service, {
      Heartbeat: (_call: any, callback: any) => {
        callback(null, { nodeId: this.config.nodeId, ok: true });
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.server.bindAsync(
        `0.0.0.0:${this.config.grpcPort}`,
        grpc.ServerCredentials.createInsecure(),
        (err) => (err ? reject(err) : resolve()),
      );
    });
    this.log.info(`gRPC listening on :${this.config.grpcPort}`);
    this.startHeartbeats();
  }

  get leaderId(): string {
    const fullList = [this.config.nodeId, ...this.config.peers.map(p => p.id)]

    const min = fullList.reduce((prev, curr) => {
      if(!prev || prev > curr){
        return curr
      }
      return prev
    }, '')

    return min;
  }

  get isLeader(): boolean {
    return this.config.nodeId === this.leaderId
  }

  private startHeartbeats(): void {
    this.timer = setInterval(() => this.tick(), this.config.heartbeatMs);
  }

  // One heartbeat round: ping every peer, then re-evaluate who looks dead.
  private tick(): void {
    const req = { nodeId: this.config.nodeId };
    for (const ps of this.peers) {
      // Bound each call so a slow/dead peer can't stall us.
      const deadline = new Date(Date.now() + this.config.heartbeatMs * 2);
      ps.client.Heartbeat(req, { deadline }, (err: any) => {
        if (!err) this.markAlive(ps);
      });
    }
    this.checkLiveness();
  }

  private markAlive(ps: PeerState): void {
    ps.lastSeen = Date.now();
    if (!ps.alive) {
      ps.alive = true;
      this.log.info(`peer ${ps.peer.id} is UP`);
    }
  }

  // A peer is declared dead only after no successful contact for the dead
  // window (not on a single failed ping) — avoids false positives.
  private checkLiveness(): void {
    const now = Date.now();
    const deadAfter = this.config.electionTimeoutMinMs;
    for (const ps of this.peers) {
      if (ps.alive && now - ps.lastSeen > deadAfter) {
        ps.alive = false;
        this.log.warn(`peer ${ps.peer.id} is DOWN`);
      }
    }
  }

  peerStatus(): Array<{ id: string; alive: boolean }> {
    return this.peers.map((p) => ({ id: p.peer.id, alive: p.alive }));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.server.forceShutdown();
  }
}
