import * as fs from 'fs';
import sqlite = require('better-sqlite3');
import {
    Database as SqliteDatabase
} from 'better-sqlite3';
import { deepEqual } from 'fast-equals';

import {
    AuthorAddress,
    Document,
    WorkspaceAddress,
} from '../util/types';
import {
    IStorage2,
    IStorageDriver,
} from './types2';
import {
    QueryOpts2,
    cleanUpQuery,
    historySortFn,
    queryMatchesDoc,
} from './query2';
import { logDebug } from '../util/log';

//================================================================================

export class DriverSqlite implements IStorageDriver {
    _workspace: WorkspaceAddress = '';
    _fn: string;
    db: SqliteDatabase = null as any as SqliteDatabase;
    constructor(fn: string) {
        this._fn = fn;
    }
    begin(storage2: IStorage2, workspace: WorkspaceAddress): void {
        logDebug(`driverSqlite.begin(workspace: ${workspace})`);
        this._workspace = workspace;

        this.db = sqlite(this._fn);

        this._ensureTables();

        let schemaVersion = this.getConfig('schemaVersion');
        logDebug(`driverSqlite.begin    schemaVersion: ${schemaVersion}`);
        if (schemaVersion === undefined) {
            schemaVersion = '1';
            this.setConfig('schemaVersion', schemaVersion);
        } else if (schemaVersion !== '1') {
            throw new Error(`sqlite file ${this._fn} has unknown schema version ${schemaVersion}`);
        }

        this.removeExpiredDocuments(Date.now() * 1000);
    }

    _ensureTables() {
        // for each path and author we can have at most one document
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS docs (
                format TEXT NOT NULL,
                workspace TEXT NOT NULL,
                path TEXT NOT NULL,
                contentHash TEXT NOT NULL,
                content TEXT NOT NULL, -- TODO: allow null
                author TEXT NOT NULL,
                timestamp NUMBER NOT NULL,
                deleteAfter NUMBER,  -- can be null
                signature TEXT NOT NULL,
                PRIMARY KEY(path, author)
            );
        `).run();
        // the config table is used to store these variables:
        //     workspace - the workspace this store was created for
        //     schemaVersion
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT NOT NULL PRIMARY KEY,
                content TEXT NOT NULL
            );
        `).run();
    }

    setConfig(key: string, content: string): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO config (key, content) VALUES (:key, :content);
        `).run({ key: key, content: content });
    }
    getConfig(key: string): string | undefined {
        let result = this.db.prepare(`
            SELECT content FROM config WHERE key = :key;
        `).get({ key: key });
        return (result === undefined) ? undefined : result.content;
    }
    deleteConfig(key: string): void {
        this.db.prepare(`
            DELETE FROM config WHERE key = :key;
        `).run({ key: key });
    }
    clearConfig(): void {
        this.db.prepare(`
            DELETE FROM config;
        `).run();
    }

    authors(now: number): AuthorAddress[] {
        // TODO
        return [];
    }
    pathQuery(query: QueryOpts2, now: number): string[] {
        // TODO
        return [];
    }
    documentQuery(query: QueryOpts2, now: number): Document[] {
        // TODO: make fancy query
        let queryString = '';
        queryString = `
            SELECT * FROM docs
            -- where...
            ORDER BY path ASC, timestamp DESC, signature DESC -- break ties with signature
            -- limit...
        `;
        logDebug('driverSqlite.documentQuery(query, now)');
        logDebug('query:', query);
        logDebug('queryString:', queryString);
        let docs: Document[] = this.db.prepare(queryString).all({});
        logDebug(`result: ${docs.length} docs`);
        docs.forEach(doc => Object.freeze(doc));
        return docs;
    }
    upsertDocument(doc: Document): void {
        // Insert new doc, replacing old doc if there is one
        logDebug(`driverSqlite.upsertDocument(doc.path: ${JSON.stringify(doc.path)})`);
        this.db.prepare(`
            INSERT OR REPLACE INTO docs (format, workspace, path, contentHash, content, author, timestamp, deleteAfter, signature)
            VALUES (:format, :workspace, :path, :contentHash, :content, :author, :timestamp, :deleteAfter, :signature);
        `).run(doc);
    }
    removeExpiredDocuments(now: number): void {
        logDebug('driverSqlite.removeExpiredDocuments(now)');
        this.db.prepare(`
            DELETE FROM docs
            WHERE deleteAfter NOT NULL AND deleteAfter < :now;
        `).run({ now });
    }
    close(): void {
        this.db.close();
    }
}
