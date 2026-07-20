import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { OfflineStorageService, PendingCapture } from './offline-storage.service';

@Injectable({ providedIn: 'root' })
export class SyncService {
  syncing = false;
  lastSyncResult = '';
  lastError = '';
  pendingCount = 0;
  progressPercent = 0;
  progressLabel = 'Preparing upload';
  activeCaptureNumber = 0;
  totalCaptures = 0;

  private syncInProgress = false;
  private activeOwnerKey = '';
  private recoveryReady: Promise<void> = Promise.resolve();
  constructor(
    private readonly api: ApiService,
    private readonly offlineStorage: OfflineStorageService
  ) {
  }

  setActiveOwner(ownerKey: string): void {
    const normalized = String(ownerKey || '').trim().toLowerCase();
    if (normalized === this.activeOwnerKey) return;
    this.activeOwnerKey = normalized;
    this.pendingCount = 0;
    this.recoveryReady = normalized
      ? this.offlineStorage.resetStuckSyncingToPending(normalized).catch(() => undefined)
      : Promise.resolve();
    void this.recoveryReady.then(() => this.refreshPendingCount());
  }

  async refreshPendingCount(): Promise<number> {
    try {
      await this.recoveryReady;
      this.pendingCount = await this.offlineStorage.getPendingCount(this.activeOwnerKey);
    } catch {
      this.pendingCount = 0;
    }
    return this.pendingCount;
  }

  async syncAll(): Promise<{ synced: number; failed: number }> {
    if (this.syncInProgress || !navigator.onLine || !this.activeOwnerKey) {
      return { synced: 0, failed: 0 };
    }

    this.syncInProgress = true;
    this.syncing = true;
    this.lastError = '';
    this.progressPercent = 1;
    this.progressLabel = 'Preparing secure upload';
    let synced = 0;
    let failed = 0;

    try {
      await this.recoveryReady;
      const pending = await this.offlineStorage.getAllPending(this.activeOwnerKey);
      this.totalCaptures = pending.length;

      for (let captureIndex = 0; captureIndex < pending.length; captureIndex += 1) {
        const capture = pending[captureIndex];
        this.activeCaptureNumber = captureIndex + 1;
        try {
          await this.syncCapture(capture, captureIndex, pending.length);
          await this.offlineStorage.deleteCapture(capture.id);
          synced++;
        } catch (error) {
          failed++;
          const errorMsg = this.describeError(error);
          this.lastError = errorMsg;
          this.progressLabel = 'Upload paused';
          await this.offlineStorage.updateSyncStatus(capture.id, 'failed', errorMsg);
        }
      }

      this.lastSyncResult = synced > 0
        ? `Synced ${synced} capture(s) successfully.${failed > 0 ? ` ${failed} failed.` : ''}`
        : (failed > 0 ? `${failed} capture(s) failed to sync.` : 'No pending captures.');

      if (failed === 0 && synced > 0) {
        this.progressPercent = 100;
        this.progressLabel = 'Upload complete';
      }

    } finally {
      this.syncInProgress = false;
      this.syncing = false;
      await this.refreshPendingCount();
    }

    return { synced, failed };
  }

  private async syncCapture(capture: PendingCapture, captureIndex: number, captureTotal: number): Promise<void> {
    await this.offlineStorage.updateSyncStatus(capture.id, 'syncing');
    const totalSteps = 2 + capture.muzzleBlobs.length + capture.evidenceBlobs.length;
    let completedSteps = 0;
    const setStage = (label: string): void => {
      const localProgress = completedSteps / Math.max(totalSteps, 1);
      this.progressPercent = Math.max(1, Math.min(99, Math.round(((captureIndex + localProgress) / Math.max(captureTotal, 1)) * 100)));
      this.progressLabel = label;
    };

    let cattleId = capture.serverCattleId || capture.cattleId;
    setStage('Creating secure cattle record');

    if (!capture.serverCattleId) {
      const enrollmentResponse = await firstValueFrom(this.api.createEnrollment({
        cattleId,
        farmerId: capture.farmerId,
        farmerName: capture.farmerName,
        fieldOfficerName: capture.fieldOfficerName,
        fieldOfficerId: capture.fieldOfficerId,
        locationLat: capture.locationLat,
        locationLon: capture.locationLon,
        locationAccuracyM: capture.locationAccuracyM,
        locationCapturedAt: capture.locationCapturedAt,
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
    completedSteps++;

    // Step 2: Upload muzzle images
    for (let index = 0; index < capture.muzzleBlobs.length; index += 1) {
      const muzzle = capture.muzzleBlobs[index];
      setStage(`Uploading muzzle photo ${index + 1} of ${capture.muzzleBlobs.length}`);
      await firstValueFrom(this.api.captureMuzzle(cattleId, muzzle.blob, muzzle.slot, true));
      completedSteps++;
    }

    // Step 3: Upload evidence images
    for (let index = 0; index < capture.evidenceBlobs.length; index += 1) {
      const evidence = capture.evidenceBlobs[index];
      setStage(`Uploading cattle photo ${index + 1} of ${capture.evidenceBlobs.length}`);
      await firstValueFrom(this.api.saveImage(cattleId, evidence.type, evidence.blob));
      completedSteps++;
    }

    // Step 4: Complete enrollment
    setStage('Creating DINOv2 embedding and saving result');
    await firstValueFrom(this.api.complete(cattleId, capture.captureDurationSeconds));
    completedSteps++;
    this.progressPercent = Math.min(100, Math.round(((captureIndex + 1) / Math.max(captureTotal, 1)) * 100));
  }

  private describeError(error: unknown): string {
    const response = error as {
      status?: number;
      message?: string;
      error?: string | { error?: string; message?: string };
    };
    const body = response?.error;
    const detail = typeof body === 'string'
      ? body
      : (body?.error || body?.message || '');

    if (response?.status === 0) {
      return 'Cannot reach the backend. Check that the field server and Cloudflare tunnel are running.';
    }
    if (response?.status === 401 || response?.status === 403) {
      return 'Your login expired. Sign in again, then retry the saved upload.';
    }
    if (response?.status && response.status >= 500) {
      return detail ? `Server processing failed: ${detail}` : 'The server could not process this record. Retry after checking the backend.';
    }
    return detail || response?.message || 'Upload failed. The record remains safe on this phone.';
  }

  destroy(): void {
    // Reserved for future native sync lifecycle hooks.
  }
}
