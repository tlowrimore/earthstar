import { deepEqual } from 'fast-equals';
import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    IValidator,
    StorageIsClosedError,
    ValidationError,
    WorkspaceAddress,
    WriteEvent,
    WriteResult,
    isErr,
    notErr,
} from '../util/types';
import { sha256base32 } from '../crypto/crypto';
import { Emitter } from '../util/emitter';
import { ValidatorEs4 } from '../validator/es4';
import {
    QueryOpts2,
    defaultQuery2,
    historySortFn,
    queryMatchesDoc,
} from './query2';

//================================================================================

interface IMegaStorage {
    workspace : WorkspaceAddress;
    onWrite : Emitter<WriteEvent>;
    onChange : Emitter<undefined>;  // deprecated

    // constructor takes: a driver, a list of validators, and a workspace

    // GET DATA OUT
    listAuthors(): AuthorAddress[];
    paths(query?: QueryOpts2): string[];
    documents(query?: QueryOpts2): Document[];
    contents(query?: QueryOpts2): string[];
    latestDocument(path: string): Document | undefined;
    latestContent(path: string): string | undefined;
    // PUT DATA IN
    ingestDocument(doc: Document, isLocal: boolean): WriteResult | ValidationError;
    set(keypair: AuthorKeypair, docToSet: DocToSet): WriteResult | ValidationError;
    // CLOSE
    close(): void;
    isClosed(): boolean;
}

interface IStorageDriver {
    // driver is responsible for actually saving, loading, querying documents
    // driver is responsible for freezing documents
    // driver does no validation
    // driver does not check if what's being stored is reasonable
    // driver doesn't make any decisions, that's MegaStorage's job
    begin(megaStorage: MegaStorage, workspace: WorkspaceAddress): void;
    listAuthors(): AuthorAddress[];
    pathQuery(query: QueryOpts2): string[];
    documentQuery(query: QueryOpts2): Document[];
    upsertDocument(doc: Document): void;  // overwrite existing doc no matter what
    close(): void;
}

//================================================================================

class MegaStorage implements IMegaStorage {
    workspace : WorkspaceAddress;
    onWrite : Emitter<WriteEvent>;
    onChange : Emitter<undefined>;  // deprecated

    _driver: IStorageDriver;
    _validatorMap : {[format: string] : IValidator};
    _isClosed: boolean = false;
    _now: number | null = null;  // used for testing time behavior.  is used instead of Date.now()

    constructor(driver: IStorageDriver, validators: IValidator[], workspace: WorkspaceAddress) {
        this.workspace = workspace;
        this.onWrite = new Emitter<WriteEvent>();
        this.onChange = new Emitter<undefined>();

        if (validators.length === 0) {
            throw new ValidationError('must provide at least one validator to MegaStorage');
        }
        // make lookup table from format to validator class
        this._validatorMap = {};
        for (let validator of validators) {
            this._validatorMap[validator.format] = validator;
        }

        // check if the workspace is valid
        let workspaceErrs = validators.map(val => val._checkWorkspaceIsValid(workspace)).filter(err => err !== true);
        if (workspaceErrs.length === validators.length) {
            // every validator had an error
            // let's throw... the first one I guess
            throw workspaceErrs[0];
        }
        // ok, at least one validator accepted the workspace address

        this._driver = driver;
        this._driver.begin(this, workspace);
    }
    // GET DATA OUT
    listAuthors(): AuthorAddress[] {
        this._assertNotClosed();
        return this._driver.listAuthors();
    }
    paths(query: QueryOpts2 = {}): string[] {
        this._assertNotClosed();
        return this._driver.pathQuery(query);
    }
    documents(query: QueryOpts2 = {}): Document[] {
        this._assertNotClosed();
        return this._driver.documentQuery(query);
    }
    contents(query: QueryOpts2 = {}): string[] {
        this._assertNotClosed();
        return this._driver.documentQuery(query)
            .map(doc => doc.content);
    }
    latestDocument(path: string): Document | undefined {
        this._assertNotClosed();
        let doc = this._driver.documentQuery({ path: path, isHead: true });
        return doc.length === 0 ? undefined : doc[0];
    }
    latestContent(path: string): string | undefined {
        this._assertNotClosed();
        let doc = this.latestDocument(path);
        return doc === undefined ? undefined : doc.content;
    }
    // PUT DATA IN
    ingestDocument(doc: Document, isLocal: boolean): WriteResult | ValidationError {
        this._assertNotClosed();

        let now = this._now || Date.now() * 1000;

        // validate doc
        let validator = this._validatorMap[doc.format];
        if (validator === undefined) {
            return new ValidationError(`ingestDocument: unrecognized format ${doc.format}`);
        }

        let err = validator.checkDocumentIsValid(doc, now);
        if (isErr(err)) { return err; }

        // Only accept docs from the same workspace.
        if (doc.workspace !== this.workspace) {
            return new ValidationError(`ingestDocument: can't ingest doc from different workspace`);
        }

        // BEGIN LOCK

        // get existing doc from same author, same path
        let existingSameAuthor : Document | undefined = this._driver.documentQuery({
            path: doc.path,
            author: doc.author,
        })[0];

        // if the existing doc from same author is expired, it should be deleted.
        // but we can just pretend we didn't see it and let it get overwritten by the incoming doc.
        if (existingSameAuthor !== undefined) {
            if (existingSameAuthor.deleteAfter !== null) {
                if (now > existingSameAuthor.deleteAfter) {
                    existingSameAuthor = undefined;
                }
            }
        }

        // Compare timestamps.
        // Compare signature to break timestamp ties.
        if (existingSameAuthor !== undefined
            && [doc.timestamp, doc.signature]
            <= [existingSameAuthor.timestamp, existingSameAuthor.signature]
            ) {
            // incoming doc is older or identical.  ignore it.
            return WriteResult.Ignored;
        }

        // upsert, replacing old doc if there is one
        this._driver.upsertDocument(doc);

        // read it again to see if it's the new latest doc
        let latestDoc = this.latestDocument(doc.path);
        let isLatest = deepEqual(doc, latestDoc);

        // END LOCK

        // Send events.
        this.onWrite.send({
            kind: 'DOCUMENT_WRITE',
            isLocal: isLocal,
            isLatest: isLatest,
            document: doc,
        });
        this.onChange.send(undefined);

        return WriteResult.Accepted;
    }
    set(keypair: AuthorKeypair, docToSet: DocToSet): WriteResult | ValidationError {
        this._assertNotClosed();

        let now = this._now || Date.now() * 1000;

        let validator = this._validatorMap[docToSet.format];
        if (validator === undefined) {
            return new ValidationError(`set: unrecognized format ${docToSet.format}`);
        }

        let shouldBumpTimestamp = false;
        if (docToSet.timestamp === 0 || docToSet.timestamp === undefined) {
            shouldBumpTimestamp = true;
            docToSet.timestamp = now;
        } else {
            // A manual timestamp was provided.  Don't bump it.
            // Make sure the timestamp (and deleteAfter timestamp) is in the valid range
            let err : true | ValidationError = validator._checkTimestampIsOk(docToSet.timestamp, docToSet.deleteAfter || null, now);
            if (isErr(err)) { return err; }
        }

        let doc : Document = {
            format: docToSet.format,
            workspace: this.workspace,
            path: docToSet.path,
            contentHash: sha256base32(docToSet.content),
            content: docToSet.content,
            author: keypair.address,
            timestamp: docToSet.timestamp,
            deleteAfter: docToSet.deleteAfter || null,
            signature: '',
        }

        // BEGIN LOCK (only needed if shouldBumpTimestamp)
        // this lock recurses into ingestDocument

        // If there's an existing doc from anyone,
        // make sure our timestamp is greater
        // even if this puts us slightly into the future.
        // (We know about the existing doc so let's assume we want to supercede it.)
        // We only do this when the user did not supply a specific timestamp.
        if (shouldBumpTimestamp) {
            // If it's an ephemeral document, remember the length of time the user wanted it to live,
            // so we can adjust the expiration timestamp too
            let lifespan: number | null = doc.deleteAfter === null ? null : (doc.deleteAfter - doc.timestamp);

            let existingDocTimestamp = this.latestDocument(doc.path)?.timestamp || 0;
            doc.timestamp = Math.max(doc.timestamp, existingDocTimestamp+1);

            if (lifespan !== null) {
                // Make the doc live the same duration it was originally supposed to live
                doc.deleteAfter = doc.timestamp + lifespan;
            }
        }

        // sign and ingest the doc
        let signedDoc = validator.signDocument(keypair, doc);
        if (isErr(signedDoc)) { return signedDoc; }
        let result = this.ingestDocument(signedDoc, true);

        // END LOCK
        return result;
    }
    // CLOSE
    close(): void {
        this._isClosed = true;
        this._driver.close();
    }
    _assertNotClosed(): void {
        if (this._isClosed) { throw new StorageIsClosedError(); }
    }
    isClosed(): boolean {
        return this._isClosed;
    }
}

//================================================================================

class MemoryDriver implements IStorageDriver {
    _docs: Record<string, Record<string, Document>> = {};  // { path: { author: document }}
    _workspace: WorkspaceAddress = '';
    _megaStorage: MegaStorage = null as any as MegaStorage;
    constructor() {
    }
    begin(megaStorage: MegaStorage, workspace: WorkspaceAddress): void {
        this._megaStorage = megaStorage;
        this._workspace = workspace;
    }
    listAuthors(): AuthorAddress[] {
        let authorMap: Record<string, boolean> = {};
        for (let slots of Object.values(this._docs)) {
            for (let author of Object.keys(slots)) {
                authorMap[author] = true;
            }
        }
        let authors = Object.keys(authorMap);
        authors.sort();
        return authors;
    }
    pathQuery(query: QueryOpts2): string[] {
        // query with no limits
        let docs = this.documentQuery({ ...query, limit: undefined, limitBytes: undefined });

        // get unique paths
        let pathMap: Record<string, boolean> = {};
        for (let doc of docs) {
            pathMap[doc.path] = true;
        }
        let paths = Object.keys(pathMap);
        paths.sort();

        // re-apply limits.  ignore limitBytes
        if (query.limit) {
            paths = paths.slice(query.limit);
        }

        return paths;
    }
    documentQuery(query: QueryOpts2): Document[] {
        // apply defaults to query
        query = { ...defaultQuery2, ...query, }

        if (query.limit === 0 || query.limitBytes === 0) { return []; }

        let results : Document[] = [];

        for (let pathSlots of Object.values(this._docs)) {
            // within one path...
            let docsThisPath = Object.values(pathSlots);
            // only keep head?
            if (query.isHead) {
                docsThisPath.sort(historySortFn);
                docsThisPath = [docsThisPath[0]];
            }
            // apply the rest of the individual query selectors: path, timestamp, author, contentSize
            docsThisPath = docsThisPath.filter(d => queryMatchesDoc(query, d));
            results = results.concat(docsThisPath);
        }

        results.sort(historySortFn);

        // apply limit and limitBytes
        if (query.limit) {
            results = results.slice(query.limit);
        }
        if (query.limitBytes) {
            let b = 0;
            for (let ii = 0; ii < results.length; ii++) {
                let doc = results[ii];
                b += doc.content.length;
                if (b > query.limitBytes) {
                    results = results.slice(ii);
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
    close(): void {}
}

//================================================================================

let storage = new MegaStorage(
    new MemoryDriver(),
    [ValidatorEs4],
    '+gardening.xxxx'
);

