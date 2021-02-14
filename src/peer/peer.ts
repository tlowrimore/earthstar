import {
    PeerIsClosedError,
    WorkspaceAddress
} from '../util/types';
import { IStorageAsync } from '../storage/storageTypes';
import {
    IKvStore,
} from './kvstore';
import { sorted } from '../util/helpers';

//================================================================================

// States that a peer can be in while it's syncing with another peer
export enum SyncMode {
    Never = 'Never',  // connection is not allowed, never try it
    Stopped = 'Stopped',  // not connected at the moment
    Connecting = 'Connecting',  // establishing a connection
    BulkSyncThenStop = 'BulkSyncThenStop',  // bulk sync is happening, then will stop
    BulkSyncThenStrea = 'BulkSyncThenStream',  // bulk sync is happening, then will live stream
    Stream = 'Stream',  // live streaming
}

//================================================================================
// PEERS

export type PeerUrl = string;
// various kinds of peer urls:
//    https://mypub.com/rpc -- mini-rpc over REST and Server-Sent Events
//    wss://mypub.com/rpc  -- mini-rpc over websockets
//    hyperswarm://swarmkey -- mini-rpc over hyperswarm streams

// Trust is used to decide if we want to connect to another peer or not.
// It's mostly about protecting your IP address.
export enum PeerTrust {
    Trusted = 'TRUSTED',  // manually user-added peers
    Unknown = 'UNKNOWN',  // auto-discovered peers, e.g. bonjour, hyperswarm
    Blocked = 'BLOCKED',  // manually user-blocked peers
}

// What we know and remember about a peer.
// This needs to be JSON serializable, so no `undefined` allowed.
export interface PeerInfo {
    readonly peerUrl: PeerUrl,

    // can be modified by user
    trust: PeerTrust,
    workspacesToSyncWithPeer: WorkspaceAddress[],

    // should be readonly by users
    commonWorkspaces: null | WorkspaceAddress[],  // workspaces we have in common with this peer, or null if unknown
    peerLastSeen: number | null,  // microseconds
}

let DEFAULT_PEER_INFO: PeerInfo = {
    peerUrl: '?',

    trust: PeerTrust.Unknown,
    workspacesToSyncWithPeer: [],

    commonWorkspaces: null,
    peerLastSeen: null,
}


//================================================================================

interface IEarthstarPeer {
    //------------------------------------------------------------
    // PEER STATE PERSISTENCE

    // kvStore is a basic async key-value store
    // which the peer uses to store its settings and state

    //constructor(kvStore: IKvStore) {

    // Notify the peer that the data in the persisted state has changed
    // (e.g. was saved in another tab)
    // This should not be called as a result of actions from this same instance.
    //onPersistenceChangeFromElsewhere(key: string, value: string | undefined): void;

    //------------------------------------------------------------
    // WORKSPACES

    // The Peer can only hold one copy of each workspace.
    // If you want to sync between two local Storages of the same worksace,
    // e.g. one in memory and one in sqlite,
    // make two Peers.
    addWorkspace(storage: IStorageAsync): void;
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined;
    listWorkspaces(): WorkspaceAddress[];
    listStorages(): IStorageAsync[];
    removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): void;

    //------------------------------------------------------------
    // PEERS

    listPeerUrls(): PeerUrl[];
    listPeerInfos(): PeerInfo[];
    getPeerInfo(peerUrl: PeerUrl): PeerInfo | undefined;
    upsertPeer(peerUrl: PeerUrl): Promise<void>;
    setPeerTrust(peerUrl: PeerUrl, trust: PeerTrust): Promise<void>;
    setWorkspacesToSyncWithPeer(peerUrl: PeerUrl, workspaceAddresses: WorkspaceAddress[]): Promise<void>;
    removePeer(peerUrl: PeerUrl): Promise<void>;

    //------------------------------------------------------------
    // CLOSING

    close(): void;
    isClosed(): boolean;
}

class EarthstarPeer implements IEarthstarPeer {
    _kvStore: IKvStore;  // for storing the peer state and settings
    _isClosed: boolean = false;
    _storages: Record<WorkspaceAddress, IStorageAsync> = {};  // one IStorage for each workspace
    _peers: Record<PeerUrl, PeerInfo> = {};

    constructor(kvStore: IKvStore) {
        this._kvStore = kvStore;
        // We don't try to load our workspaces here.
        // It's up to the user of this Peer class to find a list of locally stored workspaces,
        // instantiate them, and call peer.addWorkspace(storage).
        // There's too many ways to find them (in localStorage?  sqlite files in a directory?)
        // and too many different constructor options for the Peer to keep track of.

        // TODO: load _peers from kvstore
    }

    //------------------------------------------------------------
    // PEER STATE PERSISTENCE

    // TODO: when and how to save to kvStore, under what keys...
    /*
    onPersistenceChangeFromElsewhere(key: string, value: string | undefined): void {
        this._assertNotClosed();
        if (value === undefined) {
            this._kvStore.deleteKey(key);
        } else {
            this._kvStore.set(key, value);
        }
    }
    */

    //------------------------------------------------------------
    // WORKSPACES

    addWorkspace(storage: IStorageAsync): void {
        this._assertNotClosed();
        this._storages[storage.workspace] = storage;
    }
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined {
        this._assertNotClosed();
        return this._storages[workspaceAddress]
    }
    listWorkspaces(): WorkspaceAddress[] {
        this._assertNotClosed();
        return sorted(Object.keys(this._storages));
    }
    listStorages(): IStorageAsync[] {
        this._assertNotClosed();
        let keys = this.listWorkspaces();
        return keys.map(key => this._storages[key]);
    }
    async removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): Promise<void> {
        this._assertNotClosed();
        let storage = this._storages[workspaceAddress];
        await storage.close(opts);
    }

    //------------------------------------------------------------
    // PEERS

    async _savePeers(): Promise<void> {
        this._kvStore.set('-peers', JSON.stringify(this._peers, null, 4));
    }

    listPeerUrls(): PeerUrl[] {
        this._assertNotClosed();
        return sorted(Object.keys(this._peers));
    }
    listPeerInfos(): PeerInfo[] {
        this._assertNotClosed();
        let urls = this.listPeerUrls();
        return urls.map(url => this._peers[url]);
    }
    getPeerInfo(peerUrl: PeerUrl): PeerInfo | undefined {
        this._assertNotClosed();
        return this._peers[peerUrl];
    }
    // Ensure a peer exists in our records.
    // If it's new, give it default trust etc.
    // If it's existing, just leave it alone.
    async upsertPeer(peerUrl: PeerUrl): Promise<void> {
        this._assertNotClosed();
        if (this._peers[peerUrl] === undefined) {
            this._peers[peerUrl] = {
                ...DEFAULT_PEER_INFO,
                peerUrl,
            };
            await this._savePeers();
        }
    }
    async setPeerTrust(peerUrl: PeerUrl, trust: PeerTrust): Promise<void> {
        this._assertNotClosed();
        if (this._peers[peerUrl] === undefined) {
            throw new Error(`can't set trust of unknown peer "${peerUrl}"`);
        }
        this._peers[peerUrl] = {
            ...this._peers[peerUrl],
            trust,
        }
        await this._savePeers();
    }
    async setWorkspacesToSyncWithPeer(peerUrl: PeerUrl, workspaceAddresses: WorkspaceAddress[]): Promise<void> {
        this._assertNotClosed();
        if (this._peers[peerUrl] === undefined) {
            throw new Error(`can't set workspaces of unknown peer "${peerUrl}"`);
        }
        this._peers[peerUrl] = {
            ...this._peers[peerUrl],
            workspacesToSyncWithPeer: workspaceAddresses,
        }
        await this._savePeers();
    }
    // Remove a peer, even if we don't even know about it, just return nothing.
    async removePeer(peerUrl: PeerUrl): Promise<void> {
        this._assertNotClosed();
        delete this._peers[peerUrl];
        await this._savePeers();
    }

    //------------------------------------------------------------
    // CLOSING

    close() {
        this._isClosed = true;
    }
    isClosed() { return this._isClosed; }
    _assertNotClosed() {
        if (this._isClosed) { throw new PeerIsClosedError(); }
    }
}

