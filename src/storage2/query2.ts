import { AuthorAddress, Document } from '../util/types';

export interface QueryOpts2 {
    path?: string,
    pathPrefix?: string,

    timestamp_gt?: number,
    timestamp_lt?: number,

    author?: AuthorAddress,

    contentSize?: number,
    contentSize_gt?: number,
    contentSize_lt?: number,

    isHead?: boolean,

    limit?: number,
    limitBytes?: number,

    // continueAfter: [path, timestamp, ...signature? author? hash?]
};

export const defaultQuery2 = {
    isHead: false,
}

export let queryMatchesDoc = (query: QueryOpts2, doc: Document): boolean => {
    if (query.path !== undefined && !(query.path === doc.path)) { return false; }
    if (query.pathPrefix !== undefined && !(doc.path.startsWith(query.pathPrefix))) { return false; }

    if (query.timestamp_gt !== undefined && !(doc.timestamp > query.timestamp_gt)) { return false; }
    if (query.timestamp_lt !== undefined && !(doc.timestamp < query.timestamp_lt)) { return false; }

    if (query.author !== undefined && !(doc.author === query.author)) { return false; }

    if (query.contentSize !== undefined && !(doc.content.length === query.contentSize)) { return false; }
    if (query.contentSize_gt !== undefined && !(doc.content.length > query.contentSize_gt)) { return false; }
    if (query.contentSize_lt !== undefined && !(doc.content.length < query.contentSize_lt)) { return false; }

    return true;
}

export let historySortFn = (a: Document, b: Document): number => {
    // When used within one path's documents, puts the winning version first.
    // path ASC (abcd), then timestamp DESC (newest first), then signature DESC (to break timestamp ties)
    if (a.path > b.path) { return 1; }
    if (a.path < b.path) { return -1; }
    if (a.timestamp < b.timestamp) { return 1; }
    if (a.timestamp > b.timestamp) { return -1; }
    if (a.signature < b.signature) { return 1; }
    if (a.signature > b.signature) { return -1; }
    return 0;
};
