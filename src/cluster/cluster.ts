import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Peer } from '../config.ts';
import type { LogEntry, Store } from '../store.ts';

type Logger = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

interface IWriteOp {
  key: string;
  value: string;
  deleted: boolean
}

export type WriteStatus = 'OK' | 'NOT_FOUND' | 'NO_MAJORITY_ACK' | 'NO_LEADER';

interface IWriteResult {
  status: WriteStatus,
  lsn?: number
}

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
      
      Replicate: (call: any, callback: any) => {
        const entry = call.request;
        this.store.apply({
            lsn: entry.lsn,
            value: entry.deleted ? null : entry.value,
            deleted: entry.deleted,
            key: entry.key
        })
        callback(null, { ok: true })
      },

      Forward: async (call: any, callback: any) => {
        const op: IWriteOp = call.request;

        const { status, lsn } = await this.write(op);

        callback(null, { status, lsn })
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

  async write(op: IWriteOp): Promise<IWriteResult> {
    if(!this.isLeader) return { status: 'NO_LEADER'}

    const storedEntry = this.store.get(op.key);
    if (storedEntry === null && op.deleted) {
      return { status: 'NOT_FOUND' }
    }

    const lsn = this.store.nextLsn();

    const entry = { key: op.key, value: op.value, lsn, deleted: op.deleted };

    const ok = await this.replicate(entry);

    if(!ok) return { status: 'NO_MAJORITY_ACK'}

    this.store.apply(entry)

    return { status: 'OK', lsn}
  }

  async replicate(entry: LogEntry): Promise<boolean> {
    const majority = Math.floor((this.config.peers.length + 1) / 2) + 1
    const followersNeeded = majority - 1

    if(followersNeeded <= 0) return true

    return new Promise<boolean>((resolve) => {
      // followers that have confirmed so far
      let acks = 0;              
      // have we already answered the caller?
      let settled = false;      

      const finish = (result: boolean) => {
        // first answer wins; ignore everyone who arrives later
        if (settled) return;    
        settled = true;
        resolve(result);
      };
      
      for (const ps of this.peers) {
        // each call must answer within 1s
        const deadline = new Date(Date.now() + 1000);

        ps.client.Replicate(entry, { deadline }, (err: any, reply: any) => {
          if (!err && reply?.ok){
            ++acks

            if(acks >= followersNeeded){
              finish(true)
            }
          }
        });
      }

      setTimeout(() => finish(false), 1000)
    })
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

  getLeaderPeer(): Peer | undefined {
    if(this.isLeader) return

    return this.config.peers.find((peer) => peer.id === this.leaderId)
  }

  forwardToLeader(op: IWriteOp): Promise<IWriteResult> {
    return new Promise((resolve) => {

      const leaderPeer = this.getLeaderPeer()

      if(!leaderPeer) return resolve({ status: 'NO_LEADER'})

      const leader = this.peers.find((client) => client.peer.id === leaderPeer.id);

      if(!leader) return resolve({ status: 'NO_LEADER'})

      leader.client.Forward(op, (err: any, reply: IWriteResult) => {
        if(err) return resolve({ status: 'NO_LEADER' })

        resolve(reply)
      })
    })
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
