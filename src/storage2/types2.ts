import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    ValidationError,
    WorkspaceAddress,
    WriteEvent,
    WriteResult,
} from '../util/types';
import { Emitter } from '../util/emitter';
import { QueryOpts2 } from './query2';

//================================================================================

export interface IStorage2 {
    workspace : WorkspaceAddress;
    onWrite : Emitter<WriteEvent>;
    onChange : Emitter<undefined>;  // deprecated
    _now: number | null;  // used for testing time behavior.  is used instead of Date.now().  normally null.

    // constructor takes: a driver, a list of validators, and a workspace

    // GET DATA OUT
    authors(): AuthorAddress[];
    paths(query?: QueryOpts2): string[];
    documents(query?: QueryOpts2): Document[];
    contents(query?: QueryOpts2): string[];
    // TODO: rename from "get" to "latest"
    getDocument(path: string): Document | undefined;
    getContent(path: string): string | undefined;
    // PUT DATA IN
    ingestDocument(doc: Document, isLocal: boolean): WriteResult | ValidationError;
    set(keypair: AuthorKeypair, docToSet: DocToSet): WriteResult | ValidationError;
    // CLOSE
    close(): void;
    isClosed(): boolean;
}

export interface IStorageDriver {
    // driver is responsible for actually saving, loading, querying documents
    // driver is responsible for freezing documents
    // driver does no validation
    // driver does not check if what's being stored is reasonable
    // driver doesn't make any decisions, that's MegaStorage's job
    begin(megaStorage: IStorage2, workspace: WorkspaceAddress): void;
    authors(): AuthorAddress[];
    pathQuery(query: QueryOpts2): string[];
    documentQuery(query: QueryOpts2): Document[];
    upsertDocument(doc: Document): void;  // overwrite existing doc no matter what
    close(): void;
}
