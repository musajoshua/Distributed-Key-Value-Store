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

            return true;
        }

        return false;
    }

    nextLsn(): number {
        return ++this.lsnCounter
    }

    get highestLsn(): number {
        return this.lsnCounter;
    }
}