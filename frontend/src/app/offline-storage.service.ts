import { Injectable } from '@angular/core';

export interface PendingCapture {
  id: string;
  cattleId: string;
  serverCattleId?: string;
  farmerId: string;
  farmerName: string;
  fieldOfficerName: string;
  fieldOfficerId?: string;
  locationLat: number | null;
  locationLon: number | null;
  locationAccuracyM?: number | null;
  locationCapturedAt?: string;
  matchRadiusKm?: number;
  workflow: 'cattle_enrolment' | 'cattle_search';
  newFarmer: boolean;
  muzzleBlobs: { slot: number; blob: Blob; confidence?: number; sharpness?: number }[];
  evidenceBlobs: { type: string; blob: Blob }[];
  createdAt: string;
  captureDurationSeconds?: number;
  syncStatus: 'draft' | 'pending' | 'syncing' | 'failed';
  lastError?: string;
  retryCount: number;
}

export interface CachedFarmer {
  key: string;
  ownerKey?: string;
  farmerId: string;
  farmerName: string;
  locationLat: number | null;
  locationLon: number | null;
  cattleCount: number;
  visitCount: number;
  imageCount: number;
  lastCaptureDate: string | null;
  updatedAt: string;
}

export interface FarmerSyncInfo {
  key: string;
  ownerKey?: string;
  farmerCount: number;
  syncedAt: string;
  datasetVersion: string;
}

// New field-test cycle: do not sync stale captures left by earlier test builds.
// Bump the database name whenever the server field data is deliberately reset.
const DB_NAME = 'vacapay_offline_v3';
const DB_VERSION = 3;
const STORE_NAME = 'pending_captures';
const FARMER_STORE_NAME = 'farmers';
const META_STORE_NAME = 'metadata';

@Injectable({ providedIn: 'root' })
export class OfflineStorageService {
  private db?: IDBDatabase;
  private dbReady: Promise<IDBDatabase>;

  constructor() {
    this.dbReady = this.openDatabase();
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not supported'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('syncStatus', 'syncStatus', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(FARMER_STORE_NAME)) {
          const farmerStore = db.createObjectStore(FARMER_STORE_NAME, { keyPath: 'key' });
          farmerStore.createIndex('farmerId', 'farmerId', { unique: false });
          farmerStore.createIndex('farmerName', 'farmerName', { unique: false });
          farmerStore.createIndex('ownerKey', 'ownerKey', { unique: false });
        } else {
          const tx = (event.target as IDBOpenDBRequest).transaction;
          const farmerStore = tx?.objectStore(FARMER_STORE_NAME);
          if (farmerStore && !farmerStore.indexNames.contains('ownerKey')) {
            farmerStore.createIndex('ownerKey', 'ownerKey', { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          db.createObjectStore(META_STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };
    });
  }

  async saveCapture(capture: PendingCapture): Promise<void> {
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(capture);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to save capture to IndexedDB'));
    });
  }

  async getCapture(id: string): Promise<PendingCapture | undefined> {
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result as PendingCapture | undefined);
      request.onerror = () => reject(new Error('Failed to read capture'));
    });
  }

  async getAllPending(): Promise<PendingCapture[]> {
    const captures = await this.getAllCaptures();
    return captures
      .filter((capture) => ['pending', 'failed', 'syncing'].includes(capture.syncStatus))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  async getAllCaptures(): Promise<PendingCapture[]> {
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as PendingCapture[]);
      request.onerror = () => reject(new Error('Failed to list all captures'));
    });
  }

  async deleteCapture(id: string): Promise<void> {
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to delete capture'));
    });
  }

  async updateSyncStatus(id: string, status: PendingCapture['syncStatus'], error?: string): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) return;
    capture.syncStatus = status;
    if (error) {
      capture.lastError = error;
      capture.retryCount = (capture.retryCount || 0) + 1;
    }
    await this.saveCapture(capture);
  }

  async updateServerCattleId(id: string, serverCattleId: string): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) return;
    capture.serverCattleId = serverCattleId;
    capture.syncStatus = 'syncing';
    await this.saveCapture(capture);
  }

  async resetStuckSyncingToPending(): Promise<void> {
    const captures = await this.getAllCaptures();
    await Promise.all(captures
      .filter((capture) => capture.syncStatus === 'syncing')
      .map((capture) => {
        capture.syncStatus = 'pending';
        return this.saveCapture(capture);
      }));
  }

  async getPendingCount(): Promise<number> {
    const pending = await this.getAllPending();
    return pending.length;
  }

  async addMuzzleToCapture(id: string, slot: number, blob: Blob, confidence?: number, sharpness?: number): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    capture.muzzleBlobs = [
      ...capture.muzzleBlobs.filter((item) => item.slot !== slot),
      { slot, blob, confidence, sharpness }
    ].sort((a, b) => a.slot - b.slot);
    await this.saveCapture(capture);
  }

  async addEvidenceToCapture(id: string, type: string, blob: Blob): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    capture.evidenceBlobs = [
      ...capture.evidenceBlobs.filter((item) => item.type !== type),
      { type, blob }
    ];
    await this.saveCapture(capture);
  }

  async setCaptureDuration(id: string, captureDurationSeconds?: number): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    if (captureDurationSeconds !== undefined) {
      capture.captureDurationSeconds = captureDurationSeconds;
    }
    await this.saveCapture(capture);
  }

  async markReadyForSync(id: string): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    capture.syncStatus = 'pending';
    delete capture.lastError;
    await this.saveCapture(capture);
  }

  async replaceFarmers(ownerKey: string, farmers: CachedFarmer[], info: Omit<FarmerSyncInfo, 'key' | 'ownerKey'>): Promise<void> {
    const safeOwnerKey = this.normalizeOwnerKey(ownerKey);
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([FARMER_STORE_NAME, META_STORE_NAME], 'readwrite');
      const farmerStore = tx.objectStore(FARMER_STORE_NAME);
      const readRequest = farmerStore.getAll();
      readRequest.onsuccess = () => {
        const existing = (readRequest.result || []) as CachedFarmer[];
        existing
          .filter((farmer) => !farmer.ownerKey || farmer.ownerKey === safeOwnerKey)
          .forEach((farmer) => farmerStore.delete(farmer.key));
        farmers.forEach((farmer) => farmerStore.put({
          ...farmer,
          key: this.scopedFarmerKey(safeOwnerKey, farmer.key || `${farmer.farmerId}:${farmer.farmerName}`),
          ownerKey: safeOwnerKey
        }));
        tx.objectStore(META_STORE_NAME).put({ key: this.farmerSyncKey(safeOwnerKey), ownerKey: safeOwnerKey, ...info } satisfies FarmerSyncInfo);
      };
      readRequest.onerror = () => reject(new Error('Failed to update farmer data on this phone'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Failed to update farmer data on this phone'));
      tx.onabort = () => reject(new Error('Farmer data update was cancelled'));
    });
  }

  async getAllFarmers(ownerKey: string): Promise<CachedFarmer[]> {
    const safeOwnerKey = this.normalizeOwnerKey(ownerKey);
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const request = db.transaction(FARMER_STORE_NAME, 'readonly').objectStore(FARMER_STORE_NAME).getAll();
      request.onsuccess = () => resolve(((request.result || []) as CachedFarmer[])
        .filter((farmer) => farmer.ownerKey === safeOwnerKey));
      request.onerror = () => reject(new Error('Failed to read farmer data from this phone'));
    });
  }

  async getFarmerSyncInfo(ownerKey: string): Promise<FarmerSyncInfo | undefined> {
    const safeOwnerKey = this.normalizeOwnerKey(ownerKey);
    const db = await this.dbReady;
    return new Promise((resolve, reject) => {
      const request = db.transaction(META_STORE_NAME, 'readonly').objectStore(META_STORE_NAME).get(this.farmerSyncKey(safeOwnerKey));
      request.onsuccess = () => resolve(request.result as FarmerSyncInfo | undefined);
      request.onerror = () => reject(new Error('Failed to read farmer update status'));
    });
  }

  private normalizeOwnerKey(ownerKey: string): string {
    return String(ownerKey || 'unknown').trim().toLowerCase() || 'unknown';
  }

  private farmerSyncKey(ownerKey: string): string {
    return `farmer_sync:${this.normalizeOwnerKey(ownerKey)}`;
  }

  private scopedFarmerKey(ownerKey: string, farmerKey: string): string {
    const prefix = `${this.normalizeOwnerKey(ownerKey)}::`;
    const rawKey = String(farmerKey || '').trim();
    return rawKey.startsWith(prefix) ? rawKey : `${prefix}${rawKey}`;
  }
}
