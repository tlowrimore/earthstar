import {
    PeerLifecycleError,
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
    addWorkspace(storage: IStorageAsync): Promise<void>;
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined;
    listWorkspaces(): WorkspaceAddress[];
    listStorages(): IStorageAsync[];
    removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): void;

    //------------------------------------------------------------
    // PEERS

    addPeer(peerUrl: PeerUrl): Promise<void>;
    getPeerInfo(peerUrl: PeerUrl): PeerInfo | undefined;
    listPeerUrls(): PeerUrl[];
    listPeerInfos(): PeerInfo[];
    updatePeer(peerUrl: PeerUrl, partialInfo: Partial<PeerInfo>): Promise<void>;
    removePeer(peerUrl: PeerUrl): Promise<void>;

    //------------------------------------------------------------
    // CLOSING

    close(): Promise<void>;
    isClosed(): boolean;
}

class EarthstarPeer implements IEarthstarPeer {

    // A peer goes through a lifecycle of 3 states.
    // After being constructed it has to be "hatched" before you can used it.
    // Then you can close it, and it stays closed.
    //
    // State transition diagram:
    //
    //   notYetHatched --> ready --> closed
    //          \                      ^
    //           \                    /
    //            \------------------/
    //
    // constructor()
    //
    //      state: "notYetHatched"
    //      You can't call any methods except hatch() and close().
    //
    // await peer.hatch()
    //
    //      state: "ready"
    //      Now you can call all the peer's methods.
    //
    // await peer.close()
    //
    //      state: "closed"
    //      You can't call any methods except close(),
    //       which does nothing since it's already closed.
    //      The peer is permanently closed and can't be opened again.
    //      Make a new one if you want to try again.
    //
    // Calling methods when the lifecycle disallows it will throw a PeerLifecycleError.
    //
    // (For convenience, these special methods can always be called no matter the state:)
    //
    //      close()
    //      isReady()
    //      isClosed()
    //

    _lifecycle: 'notYetHatched' | 'ready' | 'closed' = 'notYetHatched';

    _kvStore: IKvStore;  // for storing the peer state and settings

    // state to persist
    _storages: Record<WorkspaceAddress, IStorageAsync> = {};  // one IStorage for each workspace
    _peers: Record<PeerUrl, PeerInfo> = {};

    constructor(kvStore: IKvStore) {
        this._kvStore = kvStore;
        // We don't try to load our workspaces here.
        // It's up to the user of this Peer class to find a list of locally stored workspaces,
        // instantiate them, and call peer.addWorkspace(storage).
        // There's too many ways to find them (in localStorage?  sqlite files in a directory?)
        // and too many different constructor options for the Peer to keep track of.

        // a Peer must be hatched before being used.
        // call "await peer.hatch()".
    }

    // Users must call this after instantiating the peer, and must
    // await it before doing anything else.
    // It loads initial data and does some async setup, so it can't be part
    // of the constructor.
    async hatch() {
        if (this._lifecycle !== 'notYetHatched') {
            throw new PeerLifecycleError(`Tried to hatch a peer that was already ${this._lifecycle}`);
        }

        // TODO: load _storages from kvStore??? see above note in the constructor

        // load peer data
        let existingPeerData = await this._kvStore.get('-peers');
        if (existingPeerData !== undefined) {
            try {
                this._peers = JSON.parse(existingPeerData);
            } catch (err) {
                console.error('error loading initial Peer._peers data from kvstore', err);
            }
        }
        this._lifecycle = 'ready';
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

    async _saveWorkspaces(): Promise<void> {
        // NOTE: we're saving the list of workspaces into
        // the Peer storage, but I'm not sure why yet.
        // We don't read this info at startup.
        // And each IStorage is responsible for its own
        // persistence.

        // look up the class of each workspace storage
        let wsAndClass: Record<string, string> = {}
        for (let storage of this.listStorages()) {
            wsAndClass[storage.workspace] = storage.constructor.name;
        }
        // save it
        this._kvStore.set('-workspaces', JSON.stringify(wsAndClass, null, 4));
    }

    async addWorkspace(storage: IStorageAsync): Promise<void> {
        this._assertReady();
        this._storages[storage.workspace] = storage;
        await this._saveWorkspaces();
    }
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined {
        this._assertReady();
        return this._storages[workspaceAddress]
    }
    listWorkspaces(): WorkspaceAddress[] {
        this._assertReady();
        return sorted(Object.keys(this._storages));
    }
    listStorages(): IStorageAsync[] {
        this._assertReady();
        let keys = this.listWorkspaces();
        return keys.map(key => this._storages[key]);
    }
    async removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): Promise<void> {
        this._assertReady();
        let storage = this._storages[workspaceAddress];
        await storage.close(opts);
        await this._saveWorkspaces();
    }

    //------------------------------------------------------------
    // PEERS

    async _savePeers(): Promise<void> {
        this._kvStore.set('-peers', JSON.stringify(this._peers, null, 4));
    }

    // Ensure a peer exists in our records.
    // If it's new, give it default trust etc.
    // If it's existing, just leave it alone.
    async addPeer(peerUrl: PeerUrl): Promise<void> {
        this._assertReady();
        if (this._peers[peerUrl] === undefined) {
            this._peers[peerUrl] = {
                ...DEFAULT_PEER_INFO,
                peerUrl,
            };
            await this._savePeers();
        }
    }
    getPeerInfo(peerUrl: PeerUrl): PeerInfo | undefined {
        this._assertReady();
        return this._peers[peerUrl];
    }
    listPeerUrls(): PeerUrl[] {
        this._assertReady();
        return sorted(Object.keys(this._peers));
    }
    listPeerInfos(): PeerInfo[] {
        this._assertReady();
        let urls = this.listPeerUrls();
        return urls.map(url => this._peers[url]);
    }
    // Update the state of a PeerInfo.
    // You can supply any subset of the keys in the PeerInfo type.
    async updatePeer(peerUrl: PeerUrl, partialInfo: Partial<PeerInfo>): Promise<void> {
        this._assertReady();
        if (this._peers[peerUrl] === undefined) {
            throw new Error(`can't set trust of unknown peer "${peerUrl}"`);
        }
        this._peers[peerUrl] = {
            ...this._peers[peerUrl],
            ...partialInfo,
        }
        await this._savePeers();
    }
    // Remove a peer.
    // This is even safe to do if we don't know the peer at all, it will
    // always just return nothing.
    async removePeer(peerUrl: PeerUrl): Promise<void> {
        this._assertReady();
        delete this._peers[peerUrl];
        await this._savePeers();
    }

    //------------------------------------------------------------
    // CLOSING

    _assertReady() {
        if (this._lifecycle !== 'ready') {
            throw new PeerLifecycleError(`Peer methods can only be called when it's "ready", but it was ${this._lifecycle}`);
        }
    }

    async close(): Promise<void> {
        this._lifecycle = 'closed';
    }
    isReady() { return this._lifecycle === 'ready'; }
    isClosed() { return this._lifecycle === 'closed'; }

}
