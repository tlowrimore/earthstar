import { IStorageAsync } from '../storage/storageTypes';
import { WorkspaceAddress } from '../util/types';

//================================================================================

enum SyncMode {
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
// possible peer urls:
//    https://mypub.com/rpc -- mini-rpc over REST and Server-Sent Events
//    wss://mypub.com/rpc  -- mini-rpc over websockets
//    hyperswarm://swarmkey -- mini-rpc over hyperswarm streams

enum PeerTrust {
    Trusted = 'Trusted',  // manually added peers
    Unknown = 'Unknown',  // auto-discovered peers, e.g. bonjour, hyperswarm
    Blocked = 'Blocked',  // manually blocked peers
}

interface PeerInfo {
    readonly peerUrl: PeerUrl,
    peerLastSeen: number | null,  // microseconds
    trust: PeerTrust,
}
let defaultPeerInfo: Partial<PeerInfo> = {
    peerLastSeen: null,
    trust: PeerTrust.Unknown,
}

//================================================================================
// PEER-WORKSPACE RELATIONSHIPS

interface PeerWorkspaceRelationship {
    // for each combination of a peer and a workspace, there is this relationship.
    readonly peerUrl: PeerUrl,
    readonly workspaceAddress: WorkspaceAddress,

    // these can be set by users of the API:
    allowSync: boolean,
    syncGoal: SyncMode,  // this can be set by users of the API

    // these should be readonly from the users side, only set from inside the class:
    currentSyncState: SyncMode,
    lastBulkSyncCompletionTime: number | null,  // microseconds.  0 = never
}
let defaultRelationship: Partial<PeerWorkspaceRelationship> = {
    allowSync: false,
    syncGoal: SyncMode.Stopped,
    currentSyncState: SyncMode.Stopped,
    lastBulkSyncCompletionTime: null,
}

interface PeerPolicy {
    peerTrustLevelNeededToPushNewWorkspacesToMe: null | PeerTrust,
    syncWithUnknownPeers: boolean,  // we always sync with Trusted peers, but what about Unknown peers?

    blockedWorkspaces: WorkspaceAddress[],
    allowedWorkspaces: WorkspaceAddress[],
    blockedPeers: PeerUrl[],
    trustedPeers: PeerUrl[],
};

//================================================================================

interface EarthstarPeer {
    /**
     * An Earthstar Peer is responsible for:
     *  - holding multiple workspace Storage instances (only one per workspace address)
     *  - discovering and remembering other peers
     *      - remembering our trust of other peers (trusted / unknown / blocked)
     *  - remembering which pubs should be synced with which peers
     *  - managing syncing (starting, stopping, etc)
     *  - remembering policy options about who can push new workspaces to us, etc
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
    _peersAndWorkspaces: Record<PeerUrl, Record<WorkspaceAddress, PeerWorkspaceRelationship>>;

    //------------------------------------------------------------
    // API FOR LOCAL USAGE

    close(): void; // stop all syncing, close() all storages, make sure all state is saved.

    listWorkspaces(): WorkspaceAddress[];
    addWorkspace(storage: IStorageAsync): void;
    removeWorkspace(storage: IStorageAsync, deleteFromDisk: boolean): void;  // this should close() the storage too
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync;

    listPeerInfos(): PeerInfo[];
    getPeerInfo(peerUrl: PeerUrl): PeerInfo;

    approvePeer(peerUrl: PeerUrl): void;
    unapprovePeer(peerUrl: PeerUrl): void;

    //------------------------------------------------------------
    // pubs and workspaces have a many-to-many relationship, like
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
    acceptInvite(invite: string): void;

    // easily stop or start all the syncing at once
    setAllSyncGoals(syncGoal: SyncMode): void;

    // peer policy
    setPeerPolicy(policy: PeerPolicy): void;
    getPeerPolicy(): PeerPolicy;

    //------------------------------------------------------------
    // TODO
    //  policy about allowing remote peers to push new workspaces to us or not

    /**
     * EVENTS
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

    // safe discovery of mutually known workspaces

    // the actual sync protocol

}







