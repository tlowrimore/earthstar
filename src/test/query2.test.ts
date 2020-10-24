import * as fs from 'fs';
import t = require('tap');
//t.runOnly = true;

import {
    AuthorKeypair,
    Document,
    FormatName,
    IStorage,
    IValidator,
    SyncOpts,
    WriteResult,
    isErr,
    notErr,
    WriteEvent,
    ValidationError,
    WorkspaceAddress,
    Path,
    DocToSet,
} from '../util/types';
import {
    generateAuthorKeypair,
    sha256base32,
} from '../crypto/crypto';
import { ValidatorEs4 } from '../validator/es4';
import { StorageMemory } from '../storage/memory';
import { StorageSqlite } from '../storage/sqlite';
import { logTest } from '../util/log';

import {
    IStorage2,
    IStorageDriver,
} from '../storage2/types2';
import {
    Storage2,
} from '../storage2/storage2';
import {
    DriverMemory,
} from '../storage2/driverMemory';
import {
    QueryOpts2,
    historySortFn,
    cleanUpQuery
} from '../storage2/query2';
import { uniq } from '../util/helpers';

//================================================================================
// prepare for test scenarios

let WORKSPACE = '+gardenclub.xxxxxxxxxxxxxxxxxxxx';
let WORKSPACE2 = '+another.xxxxxxxxxxxxxxxxxxxx';

let VALIDATORS : IValidator[] = [ValidatorEs4];
let FORMAT : FormatName = VALIDATORS[0].format;

let keypair1 = generateAuthorKeypair('test') as AuthorKeypair;
let keypair2 = generateAuthorKeypair('twoo') as AuthorKeypair;
let keypair3 = generateAuthorKeypair('thre') as AuthorKeypair;
let keypair4 = generateAuthorKeypair('four') as AuthorKeypair;
if (isErr(keypair1)) { throw "oops"; }
if (isErr(keypair2)) { throw "oops"; }
if (isErr(keypair3)) { throw "oops"; }
if (isErr(keypair4)) { throw "oops"; }
let author1 = keypair1.address;
let author2 = keypair2.address;
let author3 = keypair3.address;
let author4 = keypair4.address;
let now = 1500000000000000;

let SEC = 1000000;
let MIN = SEC * 60;
let HOUR = MIN * 60;
let DAY = HOUR * 24;

type MakeDocOpts = {
        workspace: WorkspaceAddress,
        keypair: AuthorKeypair,
        path: Path,
        content: string,
        timestamp: number,
        deleteAfter?: number,
}
let makeDoc = (opts: MakeDocOpts): Document => {
    let docToSet: DocToSet = {
        format: FORMAT,
        path: opts.path,
        content: opts.content,
    }
    let doc: Document = {
        format: docToSet.format,
        workspace: opts.workspace,
        path: docToSet.path,
        contentHash: sha256base32(docToSet.content),
        content: docToSet.content,
        author: opts.keypair.address,
        timestamp: opts.timestamp,
        deleteAfter: opts.deleteAfter || null,
        signature: '',
    }
    let validator = VALIDATORS[0];
    let signedDoc = validator.signDocument(opts.keypair, doc);
    if (isErr(signedDoc)) { throw signedDoc; }
    return signedDoc;
}

t.test('cleanUpQuery', (t: any) => {
    type TestCase = {
        query: QueryOpts2,
        result: QueryOpts2 | 'same',
        note?: string,
    }
    let testCases: TestCase[] = [
        {
            query: {},
            result: 'same',
        }
    ];

    for (let { query, result, note } of testCases) {
        note = (note || '') + ' ' + JSON.stringify(query);
        let expected = result === 'same' ? query : result;
        t.same(cleanUpQuery(query), expected, note);
    }

    t.end();
});
