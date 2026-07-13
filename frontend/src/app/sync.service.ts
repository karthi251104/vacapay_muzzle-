import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { OfflineStorageService, PendingCapture } from './offline-storage.service';

@Injectable({ providedIn: 'root' })
export class SyncService {
  syncing = false;
  lastSyncResult = '';
  pendingCount = 0;

  private syncInProgress = false;
  constructor(
    private readonly api: ApiService,
    private readonly offlineStorage: OfflineStorageService
  ) {
    void this.offlineStorage.resetStuckSyncingToPending();
    this.refreshPendingCount();
  }

  async refreshPendingCount(): Promise<number> {
    try {
      this.pendingCount = await this.offlineStorage.getPendingCount();
    } catch {
      this.pendingCount = 0;
    }
    return this.pendingCount;
  }

  async syncAll(): Promise<{ synced: number; failed: number }> {
    if (this.syncInProgress || !navigator.onLine) {
      return { synced: 0, failed: 0 };
    }

    this.syncInProgress = true;
    this.syncing = true;
    let synced = 0;
    let failed = 0;

    try {
      const pending = await this.offlineStorage.getAllPending();

      for (const capture of pending) {
        try {
          await this.syncCapture(capture);
          await this.offlineStorage.deleteCapture(capture.id);
          synced++;
        } catch (error) {
          failed++;
          const errorMsg = error instanceof Error ? error.message : 'Sync failed';
          await this.offlineStorage.updateSyncStatus(capture.id, 'failed', errorMsg);
        }
      }

      this.lastSyncResult = synced > 0
        ? `Synced ${synced} capture(s) successfully.${failed > 0 ? ` ${failed} failed.` : ''}`
        : (failed > 0 ? `${failed} capture(s) failed to sync.` : 'No pending captures.');

    } finally {
      this.syncInProgress = false;
      this.syncing = false;
      await this.refreshPendingCount();
    }

    return { synced, failed };
  }

  private async syncCapture(capture: PendingCapture): Promise<void> {
    await this.offlineStorage.updateSyncStatus(capture.id, 'syncing');

    let cattleId = capture.serverCattleId || capture.cattleId;

    if (!capture.serverCattleId) {
      const enrollmentResponse = await firstValueFrom(this.api.createEnrollment({
        cattleId,
        farmerId: capture.farmerId,
        farmerName: capture.farmerName,
        fieldOfficerName: capture.fieldOfficerName,
        fieldOfficerId: capture.fieldOfficerId,
        locationLat: capture.locationLat,
        locationLon: capture.locationLon,
        matchRadiusKm: capture.matchRadiusKm || 7,
        newFarmer: capture.newFarmer,
        workflow: capture.workflow,
        offlineCaptureId: capture.id
      }));

      if (!enrollmentResponse?.enrollment) {
        throw new Error('Failed to create enrollment during sync');
      }

      cattleId = enrollmentResponse.enrollment.cattleId;
      await this.offlineStorage.updateServerCattleId(capture.id, cattleId);
    }

    // Step 2: Upload muzzle images
    for (const muzzle of capture.muzzleBlobs) {
      await firstValueFrom(this.api.captureMuzzle(cattleId, muzzle.blob, muzzle.slot, true));
    }

    // Step 3: Upload evidence images
    for (const evidence of capture.evidenceBlobs) {
      await firstValueFrom(this.api.saveImage(cattleId, evidence.type, evidence.blob));
    }

    // Step 4: Complete enrollment
    await firstValueFrom(this.api.complete(cattleId, capture.captureDurationSeconds));
  }

  destroy(): void {
    // Reserved for future native sync lifecycle hooks.
  }
}
