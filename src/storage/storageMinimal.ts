import Logger from '../util/log';
import {
    Document,
    IValidator,
    ValidationError,
    WorkspaceAddress,
} from '../util/types';
import {
    Query,
    QueryForForget,
    cleanUpQuery,
    documentIsExpired,
    queryMatchesDoc,
    sortLatestFirst,
    sortPathAscAuthorAsc,
} from './query';
import {
    StorageBase,
} from './storageBase';

//================================================================================

let logger = new Logger('StorageMinimal');

// This is the minimal possible IStorage.
// It overrides StorageBase's abstract methods in the
// simplest possible way, with no optimizations.

export class StorageMinimal extends StorageBase {
    _docs: Record<string, Record<string, Document>> = {};  // { path: { author: document }}
    _config: Record<string, string> = {};

    constructor(validators: IValidator[], workspace: WorkspaceAddress) {
        super(validators, workspace);
        logger.log('constructor for workspace ' + workspace);        
    }

    setConfig(key: string, content: string): void {
        this._config[key] = content;
    }
    getConfig(key: string): string | undefined {
        return this._config[key];
    }
    deleteConfig(key: string): void {
        delete this._config[key];
    }
    deleteAllConfig(): void {
        this._config = {};
    }

    documents(q?: Query): Document[] {
        this._assertNotClosed();
        let query = cleanUpQuery(q || {});

        if (query.limit === 0 || query.limitBytes === 0) { return []; }

        let now = this._now || (Date.now() * 1000);
        let results: Document[] = [];

        // which paths should we consider?
        let pathsToConsider = Object.keys(this._docs);

        for (let path of pathsToConsider) {
            // within one path...
            let pathSlots = this._docs[path];
            let docsThisPath = Object.values(pathSlots);

            if (query.history === 'latest') {
                // only keep latest, and use signature as tiebreaker
                docsThisPath.sort(sortLatestFirst);
                docsThisPath = [docsThisPath[0]];
            } else if (query.history === 'all') {
                // keep all docs at this path
            } else {
                /* istanbul ignore next */
                throw new ValidationError('unexpected query.history value: ' + JSON.stringify(query.history));
            }

            // apply the rest of the individual query selectors: path, timestamp, author, contentLength
            // and continueAfter
            // and skip expired ephemeral docs
            docsThisPath
                .filter(doc => queryMatchesDoc(query, doc) && (doc.deleteAfter === null || now <= doc.deleteAfter))
                .forEach(doc => results.push(doc));
        }

        // sort overall results by path, then author within a path
        results.sort(sortPathAscAuthorAsc);

        // apply limit and limitBytes
        if (query.limit !== undefined) {
            results = results.slice(0, query.limit);
        }

        if (query.limitBytes !== undefined) {
            let bytes = 0;
            for (let ii = 0; ii < results.length; ii++) {
                let doc = results[ii];
                // count content length in bytes in utf-8 encoding, not number of characters
                // TODO: test this works in browsers
                // https://stackoverflow.com/questions/5515869/string-length-in-bytes-in-javascript
                let len = Buffer.byteLength(doc.content, 'utf-8');
                bytes += len;
                // if we hit limitBytes but the next item's content is '',
                // return early (don't include the empty item)
                if (bytes > query.limitBytes || (bytes === query.limitBytes && len === 0)) {
                    results = results.slice(0, ii);
                    break;
                }
            }
        }

        return results;
    }

    _upsertDocument(doc: Document): void {
        this._assertNotClosed();
        Object.freeze(doc);
        let slots: Record<string, Document> = this._docs[doc.path] || {};
        slots[doc.author] = doc;
        this._docs[doc.path] = slots;
    }

    _filterDocs(shouldKeep: (doc: Document) => boolean): void {
        // throw away docs that we don't want to keep
        this._assertNotClosed();
        // using "for... in" on purpose since we're deleting while iterating
        // instead of "for... of"
        for (let path in this._docs) {
            let slots = this._docs[path];
            // delete expired docs from slots
            for (let author in slots) {
                let doc = slots[author];
                if (!shouldKeep(doc)) {
                    delete slots[author];
                }
            }
            // if slots are empty, remove the entire set of slots
            if (Object.keys(slots).length === 0) {
                delete this._docs[path];
            }
        }
    }

    forgetDocuments(q: QueryForForget): void {
        this._assertNotClosed();
        let query = cleanUpQuery(q);
        if (query.limit === 0 || query.limitBytes === 0) { return; }
        if (query.history !== 'all') {
            throw new ValidationError('forgetDocuments can only be called with history: "all"');
        }
        this._filterDocs((doc) => !queryMatchesDoc(query, doc));
    }

    discardExpiredDocuments(): void {
        this._assertNotClosed();
        let now = this._now || (Date.now() * 1000);
        this._filterDocs((doc) => !documentIsExpired(doc, now));
    }

    _close(opts: { delete: boolean }): void { 
        logger.log(`🛑 _close() - ${this.workspace} - (is mostly a no-nop for StorageMinimal)`)
    }
}
