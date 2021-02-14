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

interface IEarthstarPeer {
    //------------------------------------------------------------
    // PEER STATE PERSISTENCE

    // The user of EarthstarPeer has to provide some persistence functions
    // so the peer can save its state.
    // This is a super basic key-value interface.
    // this is provided in the constructor

    // Notify the peer that the data in the persisted state has changed
    // (e.g. was saved in another tab)
    // This should not be called as a result of actions from this same instance.
    onPersistenceChangeFromElsewhere(key: string, value: string | undefined): void;

    //------------------------------------------------------------
    // WORKSPACES

    addWorkspace(storage: IStorageAsync): void;
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined;
    listWorkspaces(): WorkspaceAddress[];
    removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): void;

    //------------------------------------------------------------
    // CLOSING

    close(): void;
    isClosed(): boolean;
}

class EarthstarPeer implements IEarthstarPeer {
    _kvStore: IKvStore;
    _isClosed: boolean = false;
    _storages: Record<WorkspaceAddress, IStorageAsync> = {};

    constructor(kvStore: IKvStore) {
        this._kvStore = kvStore;
    }

    //------------------------------------------------------------
    // PEER STATE PERSISTENCE

    // TODO: when and how to save to kvStore, under what keys...

    onPersistenceChangeFromElsewhere(key: string, value: string | undefined): void {
        this._assertNotClosed();
        if (value === undefined) {
            this._kvStore.deleteKey(key);
        } else {
            this._kvStore.set(key, value);
        }
    }

    //------------------------------------------------------------
    // WORKSPACES

    addWorkspace(storage: IStorageAsync): void {
        this._storages[storage.workspace] = storage;
    }
    getWorkspaceStorage(workspaceAddress: WorkspaceAddress): IStorageAsync | undefined {
        return this._storages[workspaceAddress]
    }
    listWorkspaces(): WorkspaceAddress[] {
        return sorted(Object.keys(this._storages));
    }
    removeAndCloseWorkspace(workspaceAddress: WorkspaceAddress, opts?: { delete: boolean} ): void {
        let storage = this._storages[workspaceAddress];
        storage.close({ delete: (opts?.delete === true) });
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

