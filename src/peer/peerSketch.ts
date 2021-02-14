import { IStorageAsync } from '../storage/storageTypes';
import { WorkspaceAddress } from '../util/types';


/**
 * We need some kind of Peer class.  This file
 * is a sketch at the jobs it will need to do.
 * 
 * Jump down to the EarthstarPeer class
 * for an overview of its responsibilities.
 * 
 * Vocabulary note: we say "peer" here instead of pub.
 * Every Earthstar instance is a peer.  Pubs are also peers.
 * In the future, users' apps may be able to connect directly to
 * each other over hyperswarm, so we need to handle any kind of
 * peer to peer connection, not just users-to-pubs.
 */


//================================================================================

// States that a peer can be in while it's syncing with another peer
enum SyncMode {
    Never = 'Never',  // never connect
    Stopped = 'Stopped',  // not connected
    Connecting = 'Connecting',  // establishing a connection
    ConnectedAndIdle = 'ConnectedAndIdle',  // net connection is open but nothing is happening
    BulkSyncThenStop = 'BulkSyncThenStop',  // bulk sync is happening, then will stop
    BulkSyncThenStrea = 'BulkSyncThenStream',  // bulk sync is happening, then will live stream
    Stream = 'Stream',  // live streaming
}

//================================================================================
// PEERS

type PeerUrl = string;
// various kinds of peer urls:
//    https://mypub.com/rpc -- mini-rpc over REST and Server-Sent Events
//    wss://mypub.com/rpc  -- mini-rpc over websockets
//    hyperswarm://swarmkey -- mini-rpc over hyperswarm streams

// Trust is used to decide if we want to connect to another peer or not.
// It's mostly about protecting your IP address.
enum PeerTrust {
    Trusted = 'Trusted',  // manually user-added peers
    Unknown = 'Unknown',  // auto-discovered peers, e.g. bonjour, hyperswarm
    Blocked = 'Blocked',  // manually user-blocked peers
}

// What we know and remember about a peer
interface PeerInfo {
    readonly peerUrl: PeerUrl,

    // can be modified by user
    trust: PeerTrust,
    workspacesToSyncWithThisPeer: WorkspaceAddress[],

    // should be readonly by users
    commonWorkspaces: null | WorkspaceAddress[],  // workspaces we have in common with this peer, or null if unknown
    peerLastSeen: number | null,  // microseconds
}
let defaultPeerInfo: Partial<PeerInfo> = {
    trust: PeerTrust.Unknown,
    workspacesToSyncWithThisPeer: [],

    commonWorkspaces: null,
    peerLastSeen: null,
}

//================================================================================
// PEER-WORKSPACE RELATIONSHIPS

// For each combination of a peer and a workspace, there is this relationship:
interface PeerWorkspaceRelationship {
    readonly peerUrl: PeerUrl,
    readonly workspaceAddress: WorkspaceAddress,

    // these can be set by users of the API:
    syncGoal: SyncMode,  // e.g. if you want sync to stop, set a syncGoal of SyncState.Stopped

    // these should be readonly from the users side, only set from inside the class:
    currentSyncState: SyncMode,  // what the sync is actually doing right now
    lastBulkSyncCompletionTime: number | null,  // microseconds
}
let defaultRelationship: Partial<PeerWorkspaceRelationship> = {
    syncGoal: SyncMode.Stopped,
    currentSyncState: SyncMode.Stopped,
    lastBulkSyncCompletionTime: null,
}

//================================================================================
// POLICY FOR THIS PEER

// This is about controlling the automated decisions that our peer makes
// related to blocking, trust, accepting new workspaces from others, etc.
//
// This is like a config file, to be used when starting up a peer.
// Peer owners will make these choices.
// These values will not change while a peer is running unless the peer owner
// changes them through some kind of web administration interface.

interface PeerPolicy {
    // Only accept new workspaces from ... nobody, Trusted, or Unknown (& Trusted) peers.
    acceptNewWorkspacesFrom: null | PeerTrust,

    // We always sync with Trusted peers who share our workspaces,
    // but what about Unknown peers?
    // Unknown peers are typically auto-discovered and we might not want them to
    // know our IP address.
    syncWithUnknownPeers: boolean,

    // Users can also configure lists of blocked/allowed workspaces and peers,
    // for moderation purposes.

    blockedWorkspaces: WorkspaceAddress[],
    allowedWorkspaces: WorkspaceAddress[],  // if this is set, only these are allowed and nothing else

    blockedPeers: PeerUrl[],  // these peers start off blocked
    trustedPeers: PeerUrl[],  // these peers start off trusted
};

//================================================================================

interface EarthstarPeer {
    /**
     * An Earthstar Peer is responsible for:
     *  - holding multiple workspace Storage instances (only one per workspace address)
     *  - discovering and remembering other peers
     *      - remembering our trust of other peers (trusted / unknown / blocked)
     *  - remembering which peers should be synced with which workspaces
     *  - managing syncing (starting, stopping, etc)
     *  - remembering policy options
     *      - blocking, trust
     *      - accept new workspaces from others?
     *      - etc
     *  - having easy methods for UI actions like "accept invitation" etc
     */

    //------------------------------------------------------------
    // CONSTRUCTOR OPTIONS
    peerPolicy: PeerPolicy,

    //------------------------------------------------------------
    // STATE WE NEED TO PERSIST

    // storages are responsible for storing their own data
    // but we have to remember the list of storages and how to instantiate them
    _storages: Record<WorkspaceAddress, IStorageAsync>;

    // list of all peers and their info, of all trust levels
    _peers: Record<PeerUrl, PeerInfo>;

    // matrix of relationships between workspaces and peers
    // e.g. which peers are allowed to sync with which workspaces
    _peerWorkspaceRelationships: Record<PeerUrl, Record<WorkspaceAddress, PeerWorkspaceRelationship>>;

    //------------------------------------------------------------
    // API FOR PERSISTING STATE

    // The user of EarthstarPeer has to provide some persistence functions
    // so the peer can save its state.
    // This is a super basic key-value interface.
    setPersistence(methods: {
        get: (key: string) => Promise<string | undefined>,
        set: (key: string, value: string) => void,
        listKeys: () => Promise<string[]>,
        deleteKey: (key: string) => Promise<void>,
        deleteAll: () => Promise<void>,
    }): void;
    // Notify the peer that the data in the persisted state has changed
    // (e.g. was saved in another tab)
    // This should not be called as a result of actions in this same tab.
    onPersistenceChangeFromElsewhere(key: string, value: string | undefined): void;

    //------------------------------------------------------------
    // API FOR LOCAL USAGE

    close(): void; // stop all syncing, close() all storages, make sure all state is saved, goodbye.
    isClosed(): boolean;

    listWorkspaces(): WorkspaceAddress[];
    addWorkspace(storage: IStorageAsync): void;
    removeWorkspace(storage: IStorageAsync, deleteFromDisk: boolean): void;  // this should close() the storage too
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync;

    listPeerInfos(): PeerInfo[];
    getPeerInfo(peerUrl: PeerUrl): PeerInfo;
    setPeerTrust(peerUrl: PeerUrl, trust: PeerTrust): void;

    //------------------------------------------------------------
    // peers and workspaces have a many-to-many relationship, like
    // they're in a big 2d table.  Each cell of the table holds
    // the relationship between that peer and that workspace.

    // figure out if one combination allows syncing or not, based on allowSync and the peerPolicy
    canPeerSyncWithWorkspace(peerUrl: PeerUrl, workspaceAddress: WorkspaceAddress): boolean;

    // look at a row or column of the grid
    // and fitler to keep only the syncable ones
    listPeersThatCanSyncWithWorkspace(workspaceAddress: WorkspaceAddress): PeerUrl[];
    listWorkspacesThatCanSyncWithPeer(peerUrl: PeerUrl): WorkspaceAddress[];

    // read relationship
    getPeerWorkspaceRelationship(peerUrl: PeerUrl, workspaceAddress: WorkspaceAddress): PeerWorkspaceRelationship;

    // modify relationships by changing syncGoal or allowSync
    setPeerWorkspaceRelationship(peerUrl: PeerUrl, workspaceAddress: WorkspaceAddress, relationship: Partial<PeerWorkspaceRelationship>): void;

    // invites
    acceptInvite(invite: string): void;
    generateInvite(workspaceAddress: WorkspaceAddress, peerUrls: PeerUrl[]): string;

    // easily stop or start all the syncing at once
    setAllSyncGoals(syncGoal: SyncMode): void;

    // peer policy
    setPeerPolicy(policy: PeerPolicy): void;
    getPeerPolicy(): PeerPolicy;

    /**
     * EVENTS: TODO
     *  should be able to subscribe to any of these events:
     * 
     *      change to peer policy
     * 
     *      on new workspace (locally added)
     *      on new workspace (pushed from remote peer)
     *      on removed workspace (deleted or not)
     *      on any new value for the list of workspaces
     * 
     *      on change to peers list
     *          added, removed
     *          change in one PeerInfo (trust leve, syncability, etc)
     *      on any new value for the list of peers
     * 
     *      on change to peer-workspace relationship
     *          allowSync (e.g. associate / dissociate a peer and a workspace)
     *          currentSyncState (e.g. sync has started or ended, or a connection has been established)
     *          syncGoal (e.g. there was a local request to start or stop syncing)
     *          sync connection error, or connection lost
     *          syncability change due to change in peer policy
     * 
     *      events from individual IStorage instances
     *          onWrite (local or remote)
     *          onWillClose
     *          onDidClose
     * 
     *      on EarthstarPeer will close
     *      on EarthstarPeer did close
     */

    //------------------------------------------------------------
    // API FOR RPC WITH OTHER PEERS

    // This will be a set of methods exposed over mini-rpc to other peers.
    // - Safe discovery of mutually known workspaces without revealing the rest
    // - The actual sync protocol for one workspace at a time
    // - A way to know if your docs have successfully synced off your computer or not, and to how many peers

}







