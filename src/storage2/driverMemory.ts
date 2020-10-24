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

//================================================================================

export class DriverMemory implements IStorageDriver {
    _docs: Record<string, Record<string, Document>> = {};  // { path: { author: document }}
    _workspace: WorkspaceAddress = '';
    _storage2: IStorage2 = null as any as IStorage2;
    constructor() {
    }
    begin(storage2: IStorage2, workspace: WorkspaceAddress): void {
        this._storage2 = storage2;
        this._workspace = workspace;
    }
    authors(now: number): AuthorAddress[] {
        let authorMap: Record<string, boolean> = {};
        for (let slots of Object.values(this._docs)) {
            for (let author of Object.keys(slots)) {
                let doc = slots[author];
                if (doc.deleteAfter !== null && doc.deleteAfter < now) { continue; }
                authorMap[author] = true;
            }
        }
        let authors = Object.keys(authorMap);
        authors.sort();
        return authors;
    }
    pathQuery(query: QueryOpts2, now: number): string[] {
        query = cleanUpQuery(query);

        if (query.limit === 0 || query.limitBytes === 0) { return []; }

        // TODO: optimization: if the query only cares about path and pathPrefix,
        // we can just filter through Object.keys(_docs)
        // instead of doing a full documentQuery
        // ... but nope, we have to filter out expired docs

        // remove limits and do query
        // note we let limitBytes go through to the document query.
        // the documentQuery also handles removing expired docs for us.
        let docs = this.documentQuery({ ...query, limit: undefined }, now);

        // get unique paths
        let pathMap: Record<string, boolean> = {};
        for (let doc of docs) {
            pathMap[doc.path] = true;
        }
        let paths = Object.keys(pathMap);
        paths.sort();

        // re-apply limits.  ignore limitBytes
        if (query.limit) {
            paths = paths.slice(0, query.limit);
        }

        return paths;
    }
    documentQuery(query: QueryOpts2, now: number): Document[] {
        query = cleanUpQuery(query);

        if (query.limit === 0 || query.limitBytes === 0) { return []; }

        let results: Document[] = [];

        // which paths should we consider?
        let pathsToConsider: string[];
        if (query.path !== undefined) {
            // optimize when a specific path is requested
            if (this._docs[query.path] === undefined) { return []; }
            pathsToConsider = [query.path];
        } else {
            // TODO: consider optimizing this more by filtering by pathPrefix here.  benchmark it
            pathsToConsider = Object.keys(this._docs);
        }

        for (let path of pathsToConsider) {
            // within one path...
            let pathSlots = this._docs[path];
            let docsThisPath = Object.values(pathSlots);
            // only keep head?
            if (query.isHead) {
                docsThisPath.sort(historySortFn);
                docsThisPath = [docsThisPath[0]];
            }
            // apply the rest of the individual query selectors: path, timestamp, author, contentSize
            // and skip expired ephemeral docs
            docsThisPath
                .filter(d => queryMatchesDoc(query, d) && (d.deleteAfter === null || now <= d.deleteAfter))
                .forEach(d => results.push(d));

            // TODO: optimize this:
            // if sort == 'path' and there's a limit,
            // we could sort pathsToConsider, then if
            // if we finish one path's documents and either of the
            // limits are exceeded, we can bail out of this loop
            // early.  We still have to do the sorting and careful
            // limit checks below, though.
        }

        results.sort(historySortFn);

        // apply limit and limitBytes
        if (query.limit !== undefined) {
            results = results.slice(0, query.limit);
        }
        if (query.limitBytes !== undefined) {
            let b = 0;
            for (let ii = 0; ii < results.length; ii++) {
                let doc = results[ii];
                b += doc.content.length;
                if (b > query.limitBytes) {
                    results = results.slice(0, ii);
                    break;
                }
            }
        }

        return results;
    }
    upsertDocument(doc: Document): void {
        Object.freeze(doc);
        let slots: Record<string, Document> = this._docs[doc.path] || {};
        slots[doc.author] = doc;
        this._docs[doc.path] = slots;
    }
    removeExpiredDocs(now: number): void {
        // TODO
    }
    close(): void {}
}
