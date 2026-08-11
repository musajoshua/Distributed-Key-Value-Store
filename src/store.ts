export interface Entry {
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
}
