import { deepEqual } from 'fast-equals';
import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    IValidator,
    QueryOpts,
    StorageIsClosedError,
    ValidationError,
    WorkspaceAddress,
    WriteEvent,
    WriteResult,
    isErr,
} from '../util/types';
import { sha256base32 } from '../crypto/crypto';
import { Emitter } from '../util/emitter';

class ICommonStorage {
    workspace : WorkspaceAddress;
    validatorMap : {[format: string] : IValidator};
    onWrite : Emitter<WriteEvent>;
    onChange : Emitter<undefined>;  // deprecated

    _now: number | null = null; // used for testing
    _subStorage: ISubStorage;
    _isClosed: boolean = false;

    constructor(subStorage: ISubStorage, workspace: WorkspaceAddress, validators: IValidator[]) {
        this._subStorage = subStorage;

        if (validators.length === 0) {
            throw new Error('must provide at least one validator');
        }

        // check if the workspace is valid
        // TODO: try with all the of validators, and only throw an error if they all fail
        let val0 : IValidator = validators[0];
        let workspaceErr = val0._checkWorkspaceIsValid(workspace);
        if (isErr(workspaceErr)) { throw workspaceErr; }
        this.workspace = workspace;

        this.onWrite = new Emitter<WriteEvent>();
        this.onChange = new Emitter<undefined>();

        this.validatorMap = {};
        for (let validator of validators) {
            this.validatorMap[validator.format] = validator;
        }
    }
    // GET DATA OUT
    listAuthors(): AuthorAddress[] {
        this._assertNotClosed();
        return this._subStorage.listAuthors();
    }
    paths(query?: QueryOpts): string[] {
        this._assertNotClosed();
        return this._subStorage.pathQuery(query);
    }
    documents(query?: QueryOpts): Document[] {
        this._assertNotClosed();
        return this._subStorage.documentQuery(query);
    }
    contents(query?: QueryOpts): string[] {
        this._assertNotClosed();
        return this._subStorage.documentQuery(query)
            .map(doc => doc.content);
    }
    latestDocument(path: string): Document | undefined {
        this._assertNotClosed();
        let doc = this._subStorage.documentQuery({ path: path, includeHistory: false });
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
        let validator = this.validatorMap[doc.format];
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
        let existingSameAuthor : Document | undefined = this._subStorage.documentQuery({
            path: doc.path,
            versionsByAuthor: doc.author,
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
        this._subStorage.upsertDocument(doc);

        // read it again to see if it's the new latest doc
        let latestDoc = this.latestDocument(doc.path);
        let isLatest = deepEqual(doc, latestDoc);

        // END LOCK

        // Send events.
        this.onWrite.send({
            kind: 'DOCUMENT_WRITE',
            isLocal: isLocal === undefined ? false : isLocal,
            isLatest: isLatest,
            document: doc,
        });
        this.onChange.send(undefined);

        return WriteResult.Accepted;
    }
    set(keypair: AuthorKeypair, docToSet: DocToSet): WriteResult | ValidationError {
        this._assertNotClosed();

        let now = this._now || Date.now() * 1000;

        let validator = this.validatorMap[docToSet.format];
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
    close() : void {
        this._isClosed = true;
        this._subStorage.close();
    }
    _assertNotClosed() : void {
        if (this._isClosed) { throw new StorageIsClosedError(); }
    }
    isClosed() : boolean {
        return this._isClosed;
    }
}

interface ISubStorage {
    // subStorage does no validation
    // subStorage is responsible for freezing documents
    listAuthors(): AuthorAddress[];
    pathQuery(query?: QueryOpts): string[];
    documentQuery(query?: QueryOpts): Document[];
    upsertDocument(doc: Document): void;
    close(): void;
}
