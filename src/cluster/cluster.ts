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

export type Role = 'follower' | 'candidate' | 'leader';

export interface IRequestVoteRequest {
  term: number;
  candidateId: string;
  lastLsn: number;
}

export interface IRequestVoteReply {
  term: number;
  voteGranted: boolean;
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
  private electionTimer?: ReturnType<typeof setTimeout>;
  private currentTerm: number;
  private role: Role;
  private votedFor: string | null;
  private leaderId: string | null = null;
  private resyncing = false;

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
    this.currentTerm = 0;
    this.role = 'follower';
    this.votedFor = null;
  }

  async listen(): Promise<void> {
    this.server.addService(ClusterService.service, {
      Heartbeat: (call: any, callback: any) => {
        const request = call.request;

        if(request.term < this.currentTerm){
          callback(null, { term: this.currentTerm, ok: false });
          return
        }

        this.currentTerm = request.term;
        this.role = 'follower';
        this.votedFor = null;
        this.leaderId = request.nodeId;
        this.resetElectionTimer();

        callback(null, {term: this.currentTerm, ok: true });

        // The leader stamps its highest LSN on every heartbeat; if it's ahead of
        // us we missed writes (were down / are new) → pull a resync to catch up.
        if (request.highestLsn > this.store.highestLsn) this.resyncFromLeader();
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

      RequestVote: async (call: any, callback: any) => {

        callback(null, this.requestVote(call.request))
      },

      Resync: (call: any, callback: any) => {
        callback(null, { entries: this.store.entriesSince(call.request.fromLsn) })
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
    this.resetElectionTimer();
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

  requestVote(req: IRequestVoteRequest): IRequestVoteReply {
    if(req.term < this.currentTerm){
      return {
        voteGranted: false,
        term: this.currentTerm
      }
    }

    if(req.term > this.currentTerm){
      this.currentTerm = req.term;
      this.role = 'follower';
      this.votedFor = null;
    }
      
    const canVote = this.votedFor === null || this.votedFor === req.candidateId;
    const isLsnUpToDate = req.lastLsn >= this.store.highestLsn;

    if(canVote && isLsnUpToDate){
      this.votedFor = req.candidateId;

      return {
        term: this.currentTerm,
        voteGranted: true
      }
    }
    

    return {
      voteGranted: false,
      term: this.currentTerm
    }

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

  get isLeader(): boolean {
    return this.role === 'leader';
  }

  // Read-only view of the role for observability (e.g. /health).
  // Only the election logic inside Cluster may mutate `role`.
  get roleName(): Role {
    return this.role;
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

  // Pull the leader's current state and merge it in via apply(). Triggered when a
  // heartbeat shows the leader's LSN ahead of ours — i.e. we were down or are new.
  private resyncFromLeader(): void {
    if (this.role !== 'follower' || this.resyncing || !this.leaderId) return;

    const leader = this.peers.find((p) => p.peer.id === this.leaderId);
    if (!leader) return;

    this.resyncing = true;
    const deadline = new Date(Date.now() + 2000);
    leader.client.Resync({ fromLsn: 0 }, { deadline }, (err: any, reply: any) => {
      this.resyncing = false;
      if (err || !reply?.entries) return;

      for (const e of reply.entries) {
        this.store.apply({ key: e.key, value: e.deleted ? null : e.value, deleted: e.deleted, lsn: e.lsn });
      }
      if (reply.entries.length > 0) {
        this.log.info(`resynced ${reply.entries.length} entries from ${this.leaderId}`);
      }
    });
  }



  private startHeartbeats(): void {
    this.timer = setInterval(() => this.tick(), this.config.heartbeatMs);
  }

  // One heartbeat round: ping every peer, then re-evaluate who looks dead.
  private tick(): void {
    if(this.role != 'leader') return;

    const req = { nodeId: this.config.nodeId, term: this.currentTerm, highestLsn: this.store.highestLsn };
    for (const ps of this.peers) {
      // Bound each call so a slow/dead peer can't stall us.
      const deadline = new Date(Date.now() + this.config.heartbeatMs * 2);
      ps.client.Heartbeat(req, { deadline }, (err: any, reply: any) => {
        if (!err) this.markAlive(ps);

        if(!err && reply.term > this.currentTerm){
          this.role = 'follower';
          this.currentTerm = reply.term;
          this.votedFor = null;
          this.leaderId = null;
          this.resetElectionTimer();
        }
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

  private resetElectionTimer() {
    if(this.electionTimer) clearTimeout(this.electionTimer)

    const min = this.config.electionTimeoutMinMs
    const max = this.config.electionTimeoutMaxMs
    
    const t = (min + Math.random() * (max - min));
    
    this.electionTimer = setTimeout(() => this.startElection(), t)
  }

  private startElection() {
    this.role = 'candidate';
    this.currentTerm++;
    this.votedFor = this.config.nodeId;
    this.leaderId = null;

    // The term this election belongs to. Captured per-call, so a late vote reply
    // can only crown us if we are STILL campaigning for this same term.
    const electionTerm = this.currentTerm;

    this.resetElectionTimer();

    let votes = 1;

    const majority = Math.floor((this.config.peers.length + 1) / 2) + 1;

    for (const ps of this.peers) {
      // A vote is worthless once this election would be superseded by the next
      // timeout, so bound the wait to the shortest election timeout.
      const deadline = new Date(Date.now() + this.config.electionTimeoutMinMs);

      ps.client.RequestVote({ term: electionTerm, candidateId: this.config.nodeId, lastLsn: this.store.highestLsn}, { deadline }, (err: any, reply: any) => {
        if(!err && reply.term > this.currentTerm){
          this.role = 'follower';
          this.currentTerm = reply.term;
          this.votedFor = null
        }else{
          if (!err && reply?.voteGranted){
            ++votes

            if(votes >= majority && this.role == 'candidate' && this.currentTerm === electionTerm){
              this.becomeLeader()
            }
          }
        }
      });
    }
  }

  becomeLeader(){
    this.role = 'leader';
    this.leaderId = this.config.nodeId;

    clearTimeout(this.electionTimer)
  }

  peerStatus(): Array<{ id: string; alive: boolean }> {
    return this.peers.map((p) => ({ id: p.peer.id, alive: p.alive }));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.server.forceShutdown();
  }
}
