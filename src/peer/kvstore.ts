import fs from 'fs';
import { sorted } from '../util/helpers';

// simple interface for an async key-value store
export interface IKvStore {
    get: (key: string) => Promise<string | undefined>,
    set: (key: string, value: string) => Promise<void>,
    listKeys: () => Promise<string[]>,
    deleteKey: (key: string) => Promise<void>,
    deleteAll: () => Promise<void>,
}

//================================================================================

export class KvStoreMemory implements IKvStore {
    _data: Record<string, string> = {};
    async get(key: string): Promise<string | undefined> {
        return Promise.resolve(this._data[key]);
    }
    async set(key: string, value: string): Promise<void> {
        this._data[key] = value;
    }
    async listKeys(): Promise<string[]> {
        return sorted(Object.keys(this._data));
    }
    async deleteKey(key: string): Promise<void> {
        delete this._data[key];
    }
    async deleteAll(): Promise<void> {
        this._data = {};
    }
}

//================================================================================

export class KvStoreJsonFile implements IKvStore {
    _data: Record<string, string> = {};
    _fn: string;
    constructor(fn: string) {
        this._fn = fn;
        if (fs.existsSync(this._fn)) {
            this._data = JSON.parse(fs.readFileSync(this._fn, 'utf-8'));
        }
    }
    _save(): void {
        fs.writeFileSync(this._fn, JSON.stringify(this._data, null, 4), 'utf-8');
    }
    async get(key: string): Promise<string | undefined> {
        return Promise.resolve(this._data[key]);
    }
    async set(key: string, value: string): Promise<void> {
        this._data[key] = value;
        this._save();
    }
    async listKeys(): Promise<string[]> {
        return sorted(Object.keys(this._data));
    }
    async deleteKey(key: string): Promise<void> {
        delete this._data[key];
        this._save();
    }
    async deleteAll(): Promise<void> {
        this._data = {};
        this._save();
    }
}

//================================================================================

export class KvStoreLocalStorage implements IKvStore {
    _prefix: string;
    constructor(prefix: string) {
        this._prefix = prefix;
    }
    async get(key: string): Promise<string | undefined> {
        let result = localStorage.getItem(this._prefix + key);
        return result === null ? undefined : result;
    }
    async set(key: string, value: string): Promise<void> {
        localStorage.setItem(this._prefix + key, value);
    }
    async listKeys(): Promise<string[]> {
        return sorted(Object.keys(localStorage));
    }
    async deleteKey(key: string): Promise<void> {
        localStorage.removeItem(key);
    }
    async deleteAll(): Promise<void> {
        for (let key of Object.keys(localStorage)) {
            if (key.startsWith(this._prefix)) {
                localStorage.removeItem(key);
            }
        }
    }
}
