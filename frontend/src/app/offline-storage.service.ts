import { Injectable } from '@angular/core';

export interface PendingCapture {
  id: string;
  cattleId: string;
  farmerId: string;
  farmerName: string;
  fieldOfficerName: string;
  fieldOfficerId?: string;
  locationLat: number | null;
  locationLon: number | null;
  workflow: 'cattle_enrolment' | 'cattle_search';
  newFarmer: boolean;
  muzzleBlobs: { slot: number; blob: Blob; confidence?: number; sharpness?: number }[];
  evidenceBlobs: { type: string; blob: Blob }[];
  createdAt: string;
  captureDurationSeconds?: number;
  syncStatus: 'pending' | 'syncing' | 'failed';
  lastError?: string;
  retryCount: number;
}

const DB_NAME = 'vacapay_offline';
const DB_VERSION = 1;
const STORE_NAME = 'pending_captures';

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

  async getPendingCount(): Promise<number> {
    const pending = await this.getAllPending();
    return pending.length;
  }

  async addMuzzleToCapture(id: string, slot: number, blob: Blob, confidence?: number, sharpness?: number): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    capture.muzzleBlobs.push({ slot, blob, confidence, sharpness });
    await this.saveCapture(capture);
  }

  async addEvidenceToCapture(id: string, type: string, blob: Blob): Promise<void> {
    const capture = await this.getCapture(id);
    if (!capture) throw new Error('Capture not found in offline storage');
    capture.evidenceBlobs.push({ type, blob });
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
}
