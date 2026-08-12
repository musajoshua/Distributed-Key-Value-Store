import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Entry {
    value: string | null;
    lsn: number;
    deleted: boolean;
}

export interface LogEntry {
    key: string;
    value: string | null;
    lsn: number;
    deleted: boolean;
}

export class Store {
    private state: Map<string, Entry> = new Map();
    private lsnCounter = 0;

    // When set, every applied write is appended here, and load() replays it on boot.
    private walPath?: string;
    // True only while replaying the log, so we don't re-append what we're reading.
    private replaying = false;

    constructor(walPath?: string) {
        this.walPath = walPath;
        if (walPath) {
            mkdirSync(dirname(walPath), { recursive: true });
        }
    }

    get(key: string): string | null {
        const entry = this.state.get(key)
        if(entry){
            if(entry.deleted){
                return null
            }
            return entry.value
        }
        return null;
    }

    put(key: string, value: string): number {
        this.state.set(key, {
            value,
            lsn: ++this.lsnCounter,
            deleted: false
        })

        return this.lsnCounter;
    }

    delete(key: string): {existed: boolean; lsn?: number} {
        const entry = this.state.get(key)
        if(entry){
            if(entry.deleted){
                return {existed: false, lsn: this.lsnCounter}
            }
            this.state.set(key, {
                value: entry.value,
                lsn: ++this.lsnCounter,
                deleted: true
            })
            return {existed: true, lsn: this.lsnCounter}
        }
        return {existed: false};

    }

    apply(entry: LogEntry): boolean{
        const currentEntry = this.state.get(entry.key)

        if(!currentEntry || entry.lsn > currentEntry.lsn){
            const { key, value, lsn, deleted } = entry
            this.state.set(key, {
                value,
                deleted,
                lsn
            });

            this.lsnCounter = Math.max(this.lsnCounter, lsn);

            this.persist(entry);

            return true;
        }

        return false;
    }

    // Append one applied write to the WAL (no-op if persistence is off or we're
    // replaying the log back into ourselves).
    private persist(entry: LogEntry): void {
        if (!this.walPath || this.replaying) return;
        appendFileSync(this.walPath, JSON.stringify(entry) + '\n');
    }

    // Rebuild in-memory state by replaying the WAL. Call once at boot, before serving.
    load(): void {
        const walPath = this.walPath;
        if (!walPath || !existsSync(walPath)) return;

        this.replaying = true;
        for (const line of readFileSync(walPath, 'utf8').split('\n')) {
            if (line.trim() === '') continue;
            this.apply(JSON.parse(line) as LogEntry);
        }
        this.replaying = false;
    }

    nextLsn(): number {
        return ++this.lsnCounter
    }

    get highestLsn(): number {
        return this.lsnCounter;
    }

    // Current state (one entry per key, tombstones included) with lsn > fromLsn.
    // fromLsn = 0 returns everything (a full snapshot); the receiver's apply()
    // merges by LSN, so gaps fill in and newer values win.
    entriesSince(fromLsn: number): LogEntry[] {
        const out: LogEntry[] = [];
        for (const [key, e] of this.state) {
            if (e.lsn > fromLsn) {
                out.push({ key, value: e.value === null ? '' : e.value, lsn: e.lsn, deleted: e.deleted });
            }
        }
        return out;
    }
}