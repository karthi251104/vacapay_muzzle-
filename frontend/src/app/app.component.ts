import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, AppUser, AppVersionStatus, CattleImageSummary, CattleMatch, CattleStats, CattleSummary, EmbeddingStatus, Enrollment, FarmerMatch, MatchReview, MuzzleMatchResolution, PineconeStatus, YoloStatus } from './api.service';
import { TfliteMuzzleDetectorService } from './tflite-muzzle-detector.service';
import { OfflineStorageService, PendingCapture } from './offline-storage.service';
import { SyncService } from './sync.service';

interface RequiredImage {
  type: string;
  label: string;
  group: string;
  previewUrl?: string;
  uploading: boolean;
}

interface DetectionBox {
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
}

type AgentScreen = 'home' | 'farmer' | 'location' | 'muzzle' | 'evidence' | 'review';


interface FieldTestMetrics {
  registeredCattle: number;
  cattleSearches: number;
  reviewedSearches: number;
  cattleFoundResults: number;
  cattleFoundCorrect: number;
  cattleFoundIncorrect: number;
  noCattleFoundResults: number;
  noCattleFoundCorrect: number;
  noCattleFoundIncorrect: number;
  top1Accuracy: number;
  top5Accuracy: number;
  pendingReview: number;
}

interface OfficerFieldSummary {
  officer: string;
  cattleSearches: number;
  reviewedSearches: number;
  cattleFoundCorrect: number;
  cattleFoundIncorrect: number;
  noCattleFoundCorrect: number;
  noCattleFoundIncorrect: number;
  top1Accuracy: number;
  top5Accuracy: number;
  avgScore: number;
  captureQuality: string;
}
interface AgentStep {
  key: AgentScreen;
  label: string;
  caption: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  batteryLevel?: number;
  captureStartTime = 0;
  isOffline = !navigator.onLine;
  pendingSyncCount = 0;
  evidenceCameraActive = false;
  evidenceCameraIndex = 0;
  private gpsCache?: { lat: number; lon: number; timestamp: number };
  private offlineCaptureId?: string;
  private batteryManager?: EventTarget;
  private readonly onOnline = () => {
    this.isOffline = false;
    this.message = 'Back online. Syncing pending captures...';
    this.syncService.syncAll().then((result) => {
      this.pendingSyncCount = this.syncService.pendingCount;
      if (result.synced > 0) {
        this.message = `${result.synced} offline capture(s) synced successfully.`;
        this.loadCattleInventory();
      }
    });
  };
  private readonly onOffline = () => {
    this.isOffline = true;
    this.message = 'You are offline. Captures will be saved locally and synced when internet returns.';
  };
  private readonly onBatteryLevelChange = () => {
    const battery = this.batteryManager as { level?: number } | undefined;
    this.batteryLevel = battery?.level;
    if (this.batteryLevel !== undefined && this.batteryLevel < 0.20) {
      this.message = 'Battery is low. Connect charger if you have many cows to capture.';
    }
  };
  ngOnInit(): void {
    this.loadAppVersion();
    this.checkBattery();
    this.setupConnectivityListeners();
    this.syncService.refreshPendingCount().then(count => {
      this.pendingSyncCount = count;
    });
  }

  private setupConnectivityListeners(): void {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  private loadAppVersion(): void {
    this.api.appVersion().subscribe({
      next: (version) => {
        this.appVersion = version;
      },
      error: () => {
        this.appVersion = undefined;
      }
    });
  }

  private async checkBattery(): Promise<void> {
    try {
      if ('getBattery' in navigator) {
        const battery = await (navigator as any).getBattery();
        this.batteryManager = battery;
        this.batteryLevel = battery.level;
        battery.addEventListener('levelchange', this.onBatteryLevelChange);
      }
    } catch {
      // ignore
    }
  }

  private playBeep(success: boolean): void {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = success ? 'sine' : 'square';
      osc.frequency.setValueAtTime(success ? 800 : 300, ctx.currentTime);
      if (success) {
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
      }
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.1);
    } catch {
      // ignore
    }
  }
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvas?: ElementRef<HTMLCanvasElement>;

  currentUser?: AppUser;
  loginIdentifier = '';
  loginPassword = '';
  loginMode: 'agent' | 'admin' = 'agent';
  agents: AppUser[] = [];
  matchReviews: MatchReview[] = [];
  allMatchReviews: MatchReview[] = [];
  cattleInventory: CattleSummary[] = [];
  cattleStats?: CattleStats;
  selectedCattleIds: string[] = [];
  selectedAdminCattle?: CattleSummary;
  adminRegistryView: 'unique' | 'duplicates' = 'unique';
  imageViewer?: { title: string; url: string };
  showAllReviews = false;
  reviewFilterDecision = 'all';
  reviewFilterOfficer = 'all';
  officerNamesForFilter: string[] = [];
  loadedMatchedImages: Record<string, CattleImageSummary[]> = {};
  expandedReviewId = '';
  readonly isNativeFieldApp = Boolean((window as any).Capacitor?.isNativePlatform?.());

  agentName = '';
  agentPhone = '';
  newAgentId = '';
  newAgentPassword = '';

  enrollment?: Enrollment;
  cattleId = '';
  captureWorkflow: 'cattle_enrolment' | 'cattle_search' = 'cattle_enrolment';
  farmerId = '';
  farmerName = '';
  farmerSearchQuery = '';
  fieldOfficerName = '';
  locationLat: number | null = null;
  locationLon: number | null = null;
  radiusKm = 7;
  selectedFarmerKey = '';
  farmerMatches: FarmerMatch[] = [];
  gpsFarmerMatches: FarmerMatch[] = [];
  nameFarmerMatches: FarmerMatch[] = [];
  searchingFarmers = false;
  searchingGpsFarmers = false;
  searchingNameFarmers = false;
  cattleMatches: CattleMatch[] = [];
  searchingCattle = false;

  muzzlePreviews: { url: string; confidence?: number; sharpness?: number }[] = [];
  cameraOn = false;
  autoCaptureOn = false;
  isDetecting = false;
  message = 'Start a new cattle capture.';
  lastConfidence?: number;
  detectionBox?: DetectionBox;
  muzzleGateState: 'idle' | 'scanning' | 'good' | 'bad' | 'uploading' | 'error' = 'idle';
  muzzleGateLabel = 'Ready';
  yoloStatus?: YoloStatus;
  embeddingStatus?: EmbeddingStatus;
  pineconeStatus?: PineconeStatus;
  appVersion?: AppVersionStatus;
  matchResolution?: MuzzleMatchResolution;
  checkingYolo = false;
  checkingEmbedding = false;
  checkingPinecone = false;
  agentScreen: AgentScreen = 'home';

  readonly muzzleImageCount = 3;

  readonly agentScreens: AgentStep[] = [
    { key: 'home', label: 'Home', caption: 'Start' },
    { key: 'farmer', label: 'Farmer', caption: 'Add' },
    { key: 'location', label: 'Find', caption: 'GPS/Name' },
    { key: 'muzzle', label: 'Muzzle', caption: `${this.muzzleImageCount} photos` },
    { key: 'evidence', label: 'Other', caption: 'Photos' },
    { key: 'review', label: 'Save', caption: 'Finish' }
  ];

  readonly requiredImages: RequiredImage[] = [
    { type: 'face1', label: 'Face 1', group: 'Face', uploading: false },
    { type: 'face2', label: 'Face 2', group: 'Face', uploading: false },
    { type: 'face3', label: 'Face 3', group: 'Face', uploading: false },
    { type: 'leftside', label: 'Left Side', group: 'Body', uploading: false },
    { type: 'rightside', label: 'Right Side', group: 'Body', uploading: false },
    { type: 'back', label: 'Back', group: 'Body', uploading: false },
    { type: 'udder', label: 'Udder', group: 'Udder', uploading: false }
  ];
  readonly totalImageCount = this.muzzleImageCount + this.requiredImages.length;

  private stream?: MediaStream;
  private captureTimer?: number;

  constructor(
    private readonly api: ApiService,
    private readonly muzzleDetector: TfliteMuzzleDetectorService,
    private readonly offlineStorage: OfflineStorageService,
    public readonly syncService: SyncService
  ) {
    if (!this.isNativeFieldApp) this.loginMode = 'admin';
    const savedUser = localStorage.getItem('vacapay_user');
    if (savedUser) {
      this.currentUser = JSON.parse(savedUser) as AppUser;
      if (this.currentUser.role === 'agent' && !this.isNativeFieldApp) {
        this.api.clearToken();
        localStorage.removeItem('vacapay_user');
        this.currentUser = undefined;
        this.message = 'Field officer access is available in the Android app. This website is for administrators.';
        return;
      }
      if (this.currentUser.role === 'agent') {
        this.fieldOfficerName = this.currentUser.name;
      }
      if (this.currentUser.role === 'admin') {
        this.loadAgents();
        this.loadMatchReviews();
        this.loadCattleInventory();
      }
    }
  }

  ngOnDestroy(): void {
    this.stopCamera();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    this.batteryManager?.removeEventListener?.('levelchange', this.onBatteryLevelChange);
    this.syncService.destroy();
  }

  login(): void {
    this.message = 'Signing in...';
    this.api.login(this.loginIdentifier, this.loginPassword).subscribe({
      next: ({ token, user }) => {
        if (user.role === 'agent' && !this.isNativeFieldApp) {
          this.api.clearToken();
          localStorage.removeItem('vacapay_user');
          this.currentUser = undefined;
          this.loginPassword = '';
          this.message = 'Use the Vacapay Field Android app for field officer access.';
          return;
        }
        this.api.setToken(token);
        this.currentUser = user;
        localStorage.setItem('vacapay_user', JSON.stringify(user));
        this.loginPassword = '';
        this.message = user.role === 'admin' ? 'Admin signed in.' : 'Agent signed in.';

        if (user.role === 'agent') {
          this.agentScreen = 'home';
          this.fieldOfficerName = user.name;
          this.checkYoloStatus();
          this.checkEmbeddingStatus();
          this.checkPineconeStatus();
          this.loadCattleInventory();
        } else {
          this.loadAgents();
          this.loadMatchReviews();
          this.loadCattleInventory();
        }
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  checkYoloStatus(): void {
    this.checkingYolo = true;
    this.muzzleDetector.isReady()
      .then(() => {
        this.yoloStatus = {
          ok: true,
          modelPath: '/assets/models/best.tflite',
          task: 'phone_tflite_detection'
        };
        this.checkingYolo = false;
        this.message = 'Phone muzzle check is ready.';
      })
      .catch((error) => {
        this.checkingYolo = false;
        this.yoloStatus = {
          ok: false,
          modelPath: '/assets/models/best.tflite',
          error: error instanceof Error ? error.message : 'Phone TFLite model could not load.'
        };
        this.message = `Phone muzzle check not ready: ${this.yoloStatus.error}`;
      });
  }

  checkEmbeddingStatus(): void {
    this.checkingEmbedding = true;
    this.api.embeddingStatus().subscribe({
      next: (status) => {
        this.embeddingStatus = status;
        this.checkingEmbedding = false;
      },
      error: (error) => {
        this.checkingEmbedding = false;
        this.embeddingStatus = {
          ok: false,
          modelPath: '',
          threshold: 0.70,
          error: this.errorMessage(error)
        };
      }
    });
  }

  checkPineconeStatus(): void {
    this.checkingPinecone = true;
    this.api.pineconeStatus().subscribe({
      next: (status) => {
        this.pineconeStatus = status;
        this.checkingPinecone = false;
      },
      error: (error) => {
        this.checkingPinecone = false;
        this.pineconeStatus = {
          ok: false,
          enabled: false,
          error: this.errorMessage(error)
        };
      }
    });
  }

  logout(): void {
    this.stopCamera();
    this.api.clearToken();
    localStorage.removeItem('vacapay_user');
    this.currentUser = undefined;
    this.enrollment = undefined;
    this.agentScreen = 'home';
    this.selectedCattleIds = [];
    this.selectedAdminCattle = undefined;
    this.imageViewer = undefined;
    this.message = 'Signed out.';
  }

  goAgentScreen(screen: AgentScreen): void {
    if (screen === 'home') {
      this.resetCaptureState(false);
      this.agentScreen = 'home';
      this.message = 'Ready for the next cattle. Start a new capture when ready.';
      return;
    }

    if (screen === 'muzzle' && !this.enrollment) {
      this.message = 'Start capture before opening the camera.';
      return;
    }

    if ((screen === 'evidence' || screen === 'review') && this.muzzlePreviews.length < this.muzzleImageCount) {
      this.message = `Capture all ${this.muzzleImageCount} muzzle images before moving ahead.`;
      return;
    }

    if (screen === 'review' && this.capturedOtherImages < this.requiredImages.length) {
      this.message = 'Finish the 7 supporting images before final review.';
      return;
    }

    this.agentScreen = screen;
  }

  beginEnrollmentFlow(): void {
    this.startNewFarmerMode();
    this.useGps();
  }

  startNewFarmerMode(): void {
    this.resetCaptureState(true);
    this.captureWorkflow = 'cattle_enrolment';
    this.farmerId = this.generateFarmerId();
    this.agentScreen = 'farmer';
    this.message = 'Farmer ID generated. Enter farmer name, save GPS, then start the first cow.';
  }

  startExistingFarmerSearch(): void {
    this.startCattleSearchFlow();
  }

  startCattleSearchFlow(): void {
    this.resetCaptureState(true);
    this.captureWorkflow = 'cattle_search';
    this.agentScreen = 'location';
    this.message = this.registeredCattleCount
      ? 'Cattle search selected. Use GPS/name, select farmer, then capture muzzle photos.'
      : 'No registered cattle yet. First use Cattle Enrolment to save cows, then use Cattle Search to test matches.';
    this.useGps();
  }

  findExistingFarmerForEnrollment(): void {
    this.resetCaptureState(false);
    this.captureWorkflow = 'cattle_enrolment';
    this.agentScreen = 'location';
    this.message = 'Cattle enrolment selected. Search and select a farmer, then enroll the cow under that farmer.';
  }

  startNewEnrollment(): void {
    this.startNewFarmerMode();
  }

  startNewFarmerCapture(): void {
    this.captureWorkflow = 'cattle_enrolment';
    if (!this.farmerName.trim()) {
      this.message = 'Enter farmer name before adding a new farmer.';
      return;
    }

    if (!this.farmerId.trim()) {
      this.farmerId = this.generateFarmerId();
    }

    if (!this.hasGps) {
      this.message = 'Use GPS first before creating this farmer.';
      return;
    }

    this.farmerMatches = [];
    this.gpsFarmerMatches = [];
    this.nameFarmerMatches = [];
    this.cattleMatches = [];
    this.message = 'New farmer selected. Starting first cow capture...';
    this.createEnrollment();
  }
  startFromRecent(cattle: CattleSummary): void {
    this.resetCaptureState(false);
    this.captureWorkflow = 'cattle_enrolment';
    this.farmerId = cattle.farmerId || '';
    this.farmerName = cattle.farmerName || '';
    this.selectedFarmerKey = [this.farmerId, this.farmerName].join(':');
    this.agentScreen = 'location';
    this.message = 'Farmer loaded for cattle enrolment. Add the next cow under this farmer or choose another farmer.';
    this.findRegisteredCattle();
  }

  continueToLocation(): void {
    if (!this.farmerName.trim()) {
      this.message = 'Farmer name is required before GPS check.';
      return;
    }

    if (!this.farmerId.trim()) {
      this.farmerId = this.generateFarmerId();
    }

    this.agentScreen = 'location';
    this.message = 'Use GPS or name search. Select the farmer, then capture muzzle photos.';
  }

  loadAgents(): void {
    this.api.listAgents().subscribe({
      next: ({ agents }) => {
        this.agents = agents;
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  loadCattleInventory(): void {
    if (!this.currentUser) return;

    this.api.listCattle().subscribe({
      next: ({ stats, cattle }) => {
        this.cattleStats = stats;
        this.cattleInventory = cattle;
        const visibleRecords = this.visibleCattleInventory;
        if (this.selectedAdminCattle) {
          const selected = visibleRecords.find((item) => item.cattleId === this.selectedAdminCattle?.cattleId);
          this.selectedAdminCattle = selected || visibleRecords[0];
        } else {
          this.selectedAdminCattle = visibleRecords[0];
        }
        this.preloadExpandedReviewImages();
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  loadMatchReviews(): void {
    this.api.listMatchReviews(false).subscribe({
      next: ({ reviews }) => {
        this.allMatchReviews = (reviews || []).sort(
          (a, b) => new Date(b.captureDate).getTime() - new Date(a.captureDate).getTime()
        );
        this.updateOfficerNamesForFilter();
        this.applyReviewFilter();
        if (!this.expandedReviewId && this.matchReviews.length) {
          this.expandedReviewId = this.matchReviews[0].auditId;
        }
        this.preloadExpandedReviewImages();
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  applyReviewFilter(): void {
    let filtered = this.showAllReviews
      ? this.allMatchReviews
      : this.allMatchReviews.filter((review) => !this.isClosedReview(review));

    if (this.reviewFilterDecision !== 'all') {
      if (this.reviewFilterDecision === 'pending') {
        filtered = filtered.filter((review) => !this.isReviewedCattleSearch(review));
      } else {
        filtered = filtered.filter((review) => review.decision === this.reviewFilterDecision);
      }
    }

    if (this.reviewFilterOfficer !== 'all') {
      filtered = filtered.filter((review) => review.fieldOfficerName === this.reviewFilterOfficer);
    }

    this.matchReviews = filtered;
    if (this.expandedReviewId && !filtered.some((review) => review.auditId === this.expandedReviewId)) {
      this.expandedReviewId = '';
    }
    if (!this.expandedReviewId && filtered.length) {
      this.expandedReviewId = filtered[0].auditId;
    }
    this.preloadExpandedReviewImages();
  }

  isClosedReview(review: MatchReview): boolean {
    return ['confirmed', 'found_correct', 'found_incorrect', 'no_cattle_correct', 'no_cattle_incorrect', 'wrong_moved_to_registered'].includes(review.reviewStatus);
  }

  toggleReviewMode(): void {
    this.showAllReviews = !this.showAllReviews;
    this.applyReviewFilter();
  }

  confirmMatchReview(review: MatchReview, correctCattleId?: string): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: correctCattleId ? 'found_incorrect' : 'found_correct',
        correctCattleId: correctCattleId || review.matchedCattleId || review.finalCattleId,
        reviewNotes: correctCattleId ? 'Admin selected a different expected cow from candidate list.' : 'Admin confirmed the cattle-found result is correct.'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.allMatchReviews = this.allMatchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.applyReviewFilter();
          this.message = `Review saved for ${updated.finalCattleId}.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  markFoundIncorrect(review: MatchReview): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'found_incorrect',
        correctCattleId: review.finalCattleId,
        reviewNotes: 'Admin confirmed the cattle-found result is incorrect.'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.allMatchReviews = this.allMatchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.applyReviewFilter();
          this.message = `Cattle-found result marked incorrect for ${updated.finalCattleId}.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  confirmNoCattleFound(review: MatchReview): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'no_cattle_correct',
        correctCattleId: review.finalCattleId,
        reviewNotes: 'Admin confirmed the no-cattle-found result is correct.'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.allMatchReviews = this.allMatchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.applyReviewFilter();
          this.message = `No-cattle-found result saved for ${updated.finalCattleId}.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  markNoCattleFoundIncorrect(review: MatchReview): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'no_cattle_incorrect',
        correctCattleId: this.metricTopMatches(review)[0]?.cattleId || review.finalCattleId,
        reviewNotes: 'Admin confirmed this should have found an existing registered cow.'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.allMatchReviews = this.allMatchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.applyReviewFilter();
          this.message = `No-cattle-found result marked incorrect for ${updated.finalCattleId}.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  moveWrongMatchToRegistered(review: MatchReview): void {
    const ok = window.confirm('Move this cattle search out and keep it as a registered cattle record?');
    if (!ok) return;

    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'wrong_moved_to_registered',
        correctCattleId: review.finalCattleId,
        reviewNotes: 'Face/side photo review showed this automatic match was wrong. Moved out as registered cattle.',
        action: 'move_out_as_registered'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.allMatchReviews = this.allMatchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.applyReviewFilter();
          this.loadCattleInventory();
          this.message = `Wrong match moved out. ${this.shortId(updated.finalCattleId)} is now registered cattle.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  createAgent(): void {
    this.api
      .createAgent({
        name: this.agentName,
        phone: this.agentPhone,
        agentId: this.newAgentId,
        password: this.newAgentPassword
      })
      .subscribe({
        next: ({ agent }) => {
          this.agents = [agent, ...this.agents];
          this.agentName = '';
          this.agentPhone = '';
          this.newAgentId = '';
          this.newAgentPassword = '';
          this.message = `Agent ${agent.name} created.`;
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  createEnrollment(): void {
    if (!this.farmerId.trim()) {
      this.farmerId = this.generateFarmerId();
    }

    if (!this.farmerName.trim()) {
      this.message = 'Farmer name is required before starting capture.';
      return;
    }

    if (!this.hasGps) {
      this.message = 'Use GPS first before starting cow capture.';
      return;
    }

    const newFarmer = !this.selectedFarmerKey;
    const isSearch = this.captureWorkflow === 'cattle_search';

    if (this.isOffline) {
      this.offlineCaptureId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      this.cattleId = `offline_cow_${this.offlineCaptureId}`;
      this.enrollment = {
        cattleId: this.cattleId,
        farmerId: this.farmerId,
        farmerName: this.farmerName,
        fieldOfficerName: this.currentUser?.name || this.fieldOfficerName,
        fieldOfficerId: this.currentUser?.agentId || '',
        locationLat: this.locationLat,
        locationLon: this.locationLon,
        workflow: this.captureWorkflow,
        rootFolderLocation: 'offline',
        folderLocation: 'offline',
        activeSessionId: 'offline',
        captureDateTime: new Date().toISOString(),
        uploadDateTime: new Date().toISOString(),
        status: 'offline_pending'
      };

      this.offlineStorage.saveCapture({
        id: this.offlineCaptureId,
        cattleId: this.cattleId,
        farmerId: this.farmerId,
        farmerName: this.farmerName,
        fieldOfficerName: this.enrollment.fieldOfficerName,
        fieldOfficerId: this.enrollment.fieldOfficerId,
        locationLat: this.locationLat,
        locationLon: this.locationLon,
        matchRadiusKm: this.radiusKm,
        workflow: this.captureWorkflow,
        newFarmer,
        muzzleBlobs: [],
        evidenceBlobs: [],
        createdAt: new Date().toISOString(),
        syncStatus: 'pending',
        retryCount: 0
      }).catch((error) => {
        this.message = `Could not save offline capture: ${error instanceof Error ? error.message : 'IndexedDB failed.'}`;
      });

      this.muzzlePreviews = [];
      this.matchResolution = undefined;
      this.requiredImages.forEach(item => { item.previewUrl = undefined; item.uploading = false; });
      this.agentScreen = 'muzzle';
      this.message = 'Offline mode: Ready to capture. Photos will be saved to your device.';
      return;
    }

    this.message = isSearch
      ? 'Starting cattle search capture...'
      : (newFarmer ? 'Creating farmer and starting first cow enrolment...' : 'Starting cattle enrolment capture...');
    this.api
      .createEnrollment({
        farmerId: this.farmerId.trim(),
        farmerName: this.farmerName.trim(),
        fieldOfficerName: this.currentUser?.name || this.fieldOfficerName,
        fieldOfficerId: this.currentUser?.agentId,
        locationLat: this.locationLat,
        locationLon: this.locationLon,
        matchRadiusKm: this.radiusKm,
        newFarmer,
        workflow: this.captureWorkflow
      })
      .subscribe({
        next: ({ enrollment }) => {
          this.enrollment = enrollment;
          this.cattleId = enrollment.cattleId;
          this.farmerId = enrollment.farmerId || this.farmerId;
          this.farmerName = enrollment.farmerName || this.farmerName;
          this.selectedFarmerKey = [this.farmerId, this.farmerName].join(':');
          this.muzzlePreviews = [];
          this.matchResolution = undefined;
          this.requiredImages.forEach((item) => {
            item.previewUrl = undefined;
            item.uploading = false;
          });
          this.agentScreen = 'muzzle';
          this.message = this.captureWorkflow === 'cattle_search'
            ? 'Cattle search ready. Capture 3 clear muzzle photos.'
            : 'Cattle enrolment ready. Capture 3 clear muzzle photos.';
          this.loadCattleInventory();
        },
        error: (error) => {
          this.message = this.errorMessage(error);
        }
      });
  }

  useGps(): void {
    if (!navigator.geolocation) {
      this.message = 'GPS is not available in this browser.';
      return;
    }

    if (this.gpsCache && Date.now() - this.gpsCache.timestamp < 5 * 60 * 1000) {
      this.locationLat = this.gpsCache.lat;
      this.locationLon = this.gpsCache.lon;
      this.message = `Using cached GPS (${this.locationLat}, ${this.locationLon}).`;
      if (this.agentScreen === 'location') {
        this.findFarmersByGps();
      }
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.locationLat = Number(position.coords.latitude.toFixed(6));
        this.locationLon = Number(position.coords.longitude.toFixed(6));
        this.gpsCache = { lat: this.locationLat, lon: this.locationLon, timestamp: Date.now() };
        this.message = `GPS location saved (${this.locationLat}, ${this.locationLon}).`;
        if (this.agentScreen === 'location') {
          this.findFarmersByGps();
        }
      },
      () => {
        this.message = 'Could not read GPS location.';
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  findFarmers(): void {
    this.findFarmersByGps();
    this.findFarmersByName();
  }

  findFarmersByGps(): void {
    if (this.locationLat === null || this.locationLon === null) {
      this.message = 'Use GPS first, then search nearby existing farmers.';
      return;
    }

    this.searchingFarmers = true;
    this.searchingGpsFarmers = true;
    this.message = 'Searching farmers near this GPS location...';
    this.api
      .searchFarmers({
        lat: this.locationLat,
        lon: this.locationLon,
        radiusKm: this.radiusKm
      })
      .subscribe({
        next: ({ farmers }) => {
          this.gpsFarmerMatches = farmers;
          this.farmerMatches = [...this.gpsFarmerMatches, ...this.nameFarmerMatches];
          this.searchingFarmers = false;
          this.searchingGpsFarmers = false;
          this.message = farmers.length
            ? `GPS found ${farmers.length} farmer(s). Select the correct farmer to load saved cows.`
            : (this.registeredCattleCount
              ? 'No registered farmers found near this GPS. Try name search or add a new farmer in Cattle Enrolment.'
              : 'No registered farmers exist yet. Use Cattle Enrolment first; cattle searches do not create farmer records.');
        },
        error: (error) => {
          this.searchingFarmers = false;
          this.searchingGpsFarmers = false;
          this.message = this.errorMessage(error);
        }
      });
  }

  findFarmersByName(): void {
    const q = (this.farmerSearchQuery || this.farmerName || this.farmerId).trim();
    if (!q) {
      this.message = 'Enter farmer name or farmer ID to search by name.';
      return;
    }

    this.searchingFarmers = true;
    this.searchingNameFarmers = true;
    this.message = 'Searching farmers by name/ID...';
    this.api
      .searchFarmers({ q, radiusKm: this.radiusKm })
      .subscribe({
        next: ({ farmers }) => {
          this.nameFarmerMatches = farmers;
          this.farmerMatches = [...this.gpsFarmerMatches, ...this.nameFarmerMatches];
          this.searchingFarmers = false;
          this.searchingNameFarmers = false;
          this.message = farmers.length
            ? `Name search found ${farmers.length} farmer(s). Select the correct farmer to load saved cows.`
            : (this.registeredCattleCount
              ? 'No registered farmer found by that name/ID. Use GPS search or add a new farmer in Cattle Enrolment.'
              : 'No registered farmers exist yet. Use Cattle Enrolment first; cattle searches do not create farmer records.');
        },
        error: (error) => {
          this.searchingFarmers = false;
          this.searchingNameFarmers = false;
          this.message = this.errorMessage(error);
        }
      });
  }

  selectFarmer(match: FarmerMatch): void {
    this.farmerId = match.farmerId || this.farmerId;
    this.farmerName = match.farmerName || this.farmerName;
    this.farmerSearchQuery = this.farmerName || this.farmerId;
    this.selectedFarmerKey = match.key || `${match.farmerId}:${match.farmerName}`;
    this.message = `${match.farmerName || match.farmerId} selected. First checking this farmer's ${match.cattleCount} cow(s), then all saved muzzle records.`;
    this.findRegisteredCattle();
  }
  findRegisteredCattle(): void {
    this.searchingCattle = true;
    this.message = 'Loading this farmer\'s saved cattle records...';
    this.api
      .searchRegisteredCattle({
        farmerId: this.farmerId,
        farmerName: this.farmerName,
        lat: this.locationLat,
        lon: this.locationLon,
        radiusKm: this.radiusKm
      })
      .subscribe({
        next: ({ cattle }) => {
          this.cattleMatches = cattle;
          this.searchingCattle = false;
          this.message = cattle.length
            ? `Found ${cattle.length} saved cow record(s) for this farmer. Now take muzzle photos to identify the correct cow.`
            : (this.captureWorkflow === 'cattle_search'
              ? 'No saved cows found under this farmer. Cattle Search can still check all registered cattle, but it will not create a new registered cow.'
              : 'No saved cows found for this farmer. Start capture to enroll the first cow.');
        },
        error: (error) => {
          this.searchingCattle = false;
          this.message = this.errorMessage(error);
        }
      });
  }

  selectRegisteredCattle(match: CattleMatch): void {
    this.farmerId = match.farmerId || this.farmerId;
    this.farmerName = match.farmerName || this.farmerName;
    this.message = `${match.cattleLabel || 'Cow'} selected for context. Muzzle photos will still confirm the exact cow before saving.`;
  }

  async startCamera(): Promise<void> {
    if (!this.enrollment) {
      this.message = 'Start capture first.';
      return;
    }

    if (!window.isSecureContext) {
      this.message = 'Camera blocked: open this app with an HTTPS dev tunnel URL, not local HTTP/IP.';
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      this.message = 'Camera API is not available in this browser.';
      return;
    }

    try {
      await this.openCamera({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      this.captureStartTime = Date.now();
      this.message = 'Camera ready. Start auto capture when muzzle is visible.';
    } catch (error) {
      if (this.shouldRetryCameraWithBasicConstraint(error)) {
        try {
          await this.openCamera({ video: true, audio: false });
          this.captureStartTime = Date.now();
          this.message = 'Camera ready. Browser used the default camera because back camera settings were rejected.';
          return;
        } catch (retryError) {
          this.message = this.cameraErrorMessage(retryError);
          return;
        }
      }

      this.message = this.cameraErrorMessage(error);
    }
  }

  private async openCamera(constraints: MediaStreamConstraints): Promise<void> {
    this.stopCamera();
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    if (this.video?.nativeElement) {
      this.video.nativeElement.srcObject = this.stream;
      this.video.nativeElement.muted = true;
      this.video.nativeElement.playsInline = true;
      await this.video.nativeElement.play();
      await this.waitForVideoFrame(this.video.nativeElement);
    }

    this.cameraOn = true;
  }

  private waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Camera opened but no video frame was received.'));
      }, 5000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('playing', onReady);
      };
      const onReady = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          cleanup();
          resolve();
        }
      };
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('playing', onReady);
      onReady();
    });
  }

  private shouldRetryCameraWithBasicConstraint(error: unknown): boolean {
    const cameraError = error instanceof DOMException ? error.name : '';
    return ['OverconstrainedError', 'NotReadableError', 'AbortError'].includes(cameraError);
  }

  private cameraErrorMessage(error: unknown): string {
    const cameraError = error instanceof DOMException ? error.name : error instanceof Error ? error.name : 'CameraError';
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';

    if (cameraError === 'NotAllowedError' || cameraError === 'PermissionDeniedError') {
      return `Camera permission is blocked by Chrome${detail}. Tap the site controls icon near the address bar, allow Camera, then press Start Camera again.`;
    }

    if (cameraError === 'NotFoundError' || cameraError === 'DevicesNotFoundError') {
      return `No camera was found on this device${detail}.`;
    }

    if (cameraError === 'NotReadableError' || cameraError === 'TrackStartError') {
      return `Camera is busy or Android blocked access${detail}. Close other camera apps/browser tabs and try again.`;
    }

    if (cameraError === 'SecurityError') {
      return `Camera blocked by browser security${detail}. Use the HTTPS Cloudflare link and allow camera for this site.`;
    }

    if (cameraError === 'OverconstrainedError') {
      return `This phone rejected the requested back-camera settings${detail}. Try again; the app will use the default camera fallback.`;
    }

    return `Camera could not start: ${cameraError}${detail}. Use HTTPS and allow camera permission.`;
  }

  stopCamera(): void {
    window.clearInterval(this.captureTimer);
    this.captureTimer = undefined;
    this.autoCaptureOn = false;
    this.cameraOn = false;
    this.detectionBox = undefined;
    this.muzzleGateState = 'idle';
    this.muzzleGateLabel = 'Ready';
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  toggleAutoCapture(): void {
    if (this.autoCaptureOn) {
      window.clearInterval(this.captureTimer);
      this.captureTimer = undefined;
      this.autoCaptureOn = false;
      this.muzzleGateState = 'idle';
      this.muzzleGateLabel = 'Paused';
      this.message = 'Auto capture paused.';
      return;
    }

    this.autoCaptureOn = true;
    this.message = 'Looking for clear muzzle...';
    this.muzzleGateState = 'scanning';
    this.muzzleGateLabel = 'Scanning';
    this.captureTimer = window.setInterval(() => {
      void this.tryCaptureMuzzle();
    }, 350);
    void this.tryCaptureMuzzle();
  }

  async tryCaptureMuzzle(): Promise<void> {
    if (!this.enrollment || !this.video || !this.canvas || this.isDetecting || this.muzzlePreviews.length >= this.muzzleImageCount) {
      if (this.muzzlePreviews.length >= this.muzzleImageCount) this.toggleAutoCapture();
      return;
    }

    this.isDetecting = true;
    this.muzzleGateState = 'scanning';
    this.muzzleGateLabel = 'Scanning';
    const slot = this.muzzlePreviews.length + 1;
    if (this.video.nativeElement.videoWidth <= 0 || this.video.nativeElement.videoHeight <= 0) {
      this.isDetecting = false;
      this.message = 'Camera preview is not ready yet. Wait one second and start auto capture again.';
      return;
    }

    this.message = `Checking muzzle photo ${slot}/${this.muzzleImageCount} on phone...`;

    let localResult;
    try {
      localResult = await this.muzzleDetector.detectAndCrop(this.video.nativeElement);
    } catch (error) {
      this.detectionBox = undefined;
      this.isDetecting = false;
      this.muzzleGateState = 'error';
      this.muzzleGateLabel = 'Model error';
      this.message = `Phone muzzle check error: ${error instanceof Error ? error.message : 'TFLite failed.'}`;
      return;
    }

    this.lastConfidence = localResult.confidence;
    this.detectionBox = this.toDetectionBox(localResult.bbox || undefined, localResult.imageSize, localResult.confidence);

    if (!localResult.accepted || !localResult.cropBlob) {
      this.isDetecting = false;
      this.muzzleGateState = 'bad';
      this.muzzleGateLabel = localResult.className === 'goodmuzzle' ? 'Hold steady' : 'Bad muzzle';
      this.message = `${localResult.reason} Hold steady and show a clean straight muzzle.`;
      return;
    }

    this.muzzleGateState = 'good';
    this.muzzleGateLabel = 'Good muzzle';

    if (this.isOffline && this.offlineCaptureId) {
      if (navigator.vibrate) navigator.vibrate(200);
      this.playBeep(true);

      this.offlineStorage.addMuzzleToCapture(
        this.offlineCaptureId,
        slot,
        localResult.cropBlob,
        localResult.confidence,
        localResult.sharpness
      ).then(() => {
        this.muzzlePreviews.push({
          url: URL.createObjectURL(localResult.cropBlob as Blob),
          confidence: localResult.confidence,
          sharpness: localResult.sharpness
        });
        this.message = `Offline: Good muzzle ${slot}/${this.muzzleImageCount} saved locally.`;
        this.muzzleGateState = 'good';
        this.muzzleGateLabel = `Saved ${slot}/${this.muzzleImageCount}`;
        this.isDetecting = false;
        if (this.muzzlePreviews.length >= this.muzzleImageCount && this.autoCaptureOn) {
          this.toggleAutoCapture();
          this.agentScreen = 'evidence';
          this.message = `Offline: all ${this.muzzleImageCount} muzzle photos saved. Add supporting photos next.`;
        }
      });
      return;
    }

    this.muzzleGateState = 'uploading';
    this.muzzleGateLabel = `Saving ${slot}/${this.muzzleImageCount}`;
    this.api.captureMuzzle(this.enrollment.cattleId, localResult.cropBlob, slot, true).subscribe({
      next: (response) => {
        if (navigator.vibrate) navigator.vibrate(200);
        this.playBeep(true);
        this.lastConfidence = localResult.confidence;
        this.detectionBox = this.toDetectionBox(localResult.bbox || undefined, localResult.imageSize, localResult.confidence);
        this.muzzlePreviews.push({
          url: localResult.cropUrl || response.cloudinaryUrl || this.api.mediaUrl(response.previewUrl),
          confidence: localResult.confidence,
          sharpness: localResult.sharpness
        });
        this.message = `Good muzzle ${slot}/${this.muzzleImageCount} saved from phone crop.`;
        this.isDetecting = false;
        this.muzzleGateState = 'good';
        this.muzzleGateLabel = `Saved ${slot}/${this.muzzleImageCount}`;

        if (response.matchResolution) {
          this.applyMatchResolution(response.matchResolution);
        }

        if (this.muzzlePreviews.length >= this.muzzleImageCount && this.autoCaptureOn) {
          this.toggleAutoCapture();
          if (response.matchPending) {
            this.message = `All ${this.muzzleImageCount} muzzle photos are saved. Matching runs when you save the completed record.`;
          } else if (!response.matchResolution) {
            this.message = `All ${this.muzzleImageCount} muzzle photos captured. Checking farmer cattle and all saved muzzle records.`;
          }
          this.agentScreen = 'evidence';
        }
      },
      error: (error) => {
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        this.playBeep(false);
        this.detectionBox = undefined;
        this.muzzleGateState = 'error';
        this.muzzleGateLabel = `Save failed ${slot}/${this.muzzleImageCount}`;
        this.message = error.status === 422
          ? `Muzzle was not clear for photo ${slot}/${this.muzzleImageCount}. Hold steady and show the full muzzle.`
          : `Capture error: ${this.errorMessage(error)}`;
        this.isDetecting = false;
      }
    });
  }

  uploadRequiredImage(event: Event, item: RequiredImage): void {
    if (!this.enrollment) {
      this.message = 'Start capture first.';
      return;
    }

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (this.isOffline && this.offlineCaptureId) {
      item.uploading = true;
      this.offlineStorage.addEvidenceToCapture(this.offlineCaptureId, item.type, file).then(() => {
        item.previewUrl = URL.createObjectURL(file);
        item.uploading = false;
        this.message = `Offline: ${item.label} saved locally.`;
        if (this.capturedOtherImages === this.requiredImages.length && this.muzzlePreviews.length === this.muzzleImageCount) {
          this.agentScreen = 'review';
        }
      });
      return;
    }

    item.uploading = true;
    this.api.saveImage(this.enrollment.cattleId, item.type, file).subscribe({
      next: (response) => {
        item.previewUrl = response.cloudinaryUrl || this.api.mediaUrl(response.previewUrl);
        item.uploading = false;
        this.message = `${item.label} saved.`;
        if (this.capturedOtherImages === this.requiredImages.length && this.muzzlePreviews.length === this.muzzleImageCount) {
          this.agentScreen = 'review';
          this.loadCattleInventory();
        }
      },
      error: (error) => {
        item.uploading = false;
        this.message = this.errorMessage(error);
      }
    });
  }

  completeEnrollment(): void {
    if (!this.enrollment) return;

    const savedFarmerId = this.farmerId || this.enrollment.farmerId || '';
    const savedFarmerName = this.farmerName || this.enrollment.farmerName || '';
    const captureDurationSeconds = this.captureStartTime ? Math.round((Date.now() - this.captureStartTime) / 1000) : undefined;

    if (this.isOffline && this.offlineCaptureId) {
      this.offlineStorage
        .setCaptureDuration(this.offlineCaptureId, captureDurationSeconds)
        .then(() => this.syncService.refreshPendingCount())
        .then(c => this.pendingSyncCount = c)
        .catch(() => {});
      this.resetCaptureState(false);
      this.farmerId = savedFarmerId;
      this.farmerName = savedFarmerName;
      this.selectedFarmerKey = `${savedFarmerId}:${savedFarmerName}`;
      this.agentScreen = 'home';
      this.message = 'Offline capture complete. It will automatically upload when you get internet.';
      return;
    }

    this.api.complete(this.enrollment.cattleId, captureDurationSeconds).subscribe({
      next: ({ enrollment }) => {
        this.enrollment = enrollment;
        this.loadCattleInventory();
        this.resetCaptureState(false);
        this.farmerId = savedFarmerId;
        this.farmerName = savedFarmerName;
        this.selectedFarmerKey = `${savedFarmerId}:${savedFarmerName}`;
        this.agentScreen = 'home';
        this.findRegisteredCattle();
        window.setTimeout(() => this.loadCattleInventory(), 900);
        if (enrollment.status === 'duplicate_saved_separately' || enrollment.workflow === 'cattle_search') {
          this.message = 'Cattle search saved separately. Use "Enrol Next Cow" to continue with the same farmer.';
        } else {
          this.message = 'Cow enrolled successfully! Use "Enrol Next Cow" to add another cow for the same farmer.';
        }
      },
      error: (error) => {
        this.prepareMissingImageRetakes(error);
        this.message = this.errorMessage(error);
      }
    });
  }

  quickEnrolNextCow(): void {
    const savedFarmerId = this.farmerId;
    const savedFarmerName = this.farmerName;
    const savedOfficer = this.fieldOfficerName;
    this.resetCaptureState(false);
    this.captureWorkflow = 'cattle_enrolment';
    this.farmerId = savedFarmerId;
    this.farmerName = savedFarmerName;
    this.fieldOfficerName = savedOfficer;
    this.selectedFarmerKey = `${savedFarmerId}:${savedFarmerName}`;
    this.message = 'Quick enrol: same farmer, new cow. Creating enrollment...';
    this.createEnrollment();
  }

  startEvidenceCamera(): void {
    this.evidenceCameraIndex = this.requiredImages.findIndex(item => !item.previewUrl);
    if (this.evidenceCameraIndex < 0) {
      this.message = 'All evidence photos are already captured.';
      return;
    }
    this.evidenceCameraActive = true;
    this.message = `Point camera at: ${this.requiredImages[this.evidenceCameraIndex].label}`;
    void this.startCamera();
  }

  async captureEvidencePhoto(): Promise<void> {
    if (!this.enrollment || !this.video || this.evidenceCameraIndex < 0) return;
    const item = this.requiredImages[this.evidenceCameraIndex];
    if (!item) return;

    try {
      const blob = await this.frameBlob();

      if (this.isOffline && this.offlineCaptureId) {
        item.uploading = true;
        this.offlineStorage.addEvidenceToCapture(this.offlineCaptureId, item.type, blob).then(() => {
           item.previewUrl = URL.createObjectURL(blob);
           item.uploading = false;
           if (navigator.vibrate) navigator.vibrate(100);
           this.playBeep(true);

           const nextIndex = this.requiredImages.findIndex((img, idx) => idx > this.evidenceCameraIndex && !img.previewUrl);
           if (nextIndex >= 0) {
             this.evidenceCameraIndex = nextIndex;
             this.message = `Offline: ${item.label} saved! Now point camera at: ${this.requiredImages[nextIndex].label}`;
           } else {
             this.evidenceCameraActive = false;
             this.stopCamera();
             this.message = 'Offline: All evidence photos captured! Review your record.';
             if (this.muzzlePreviews.length >= this.muzzleImageCount) {
               this.agentScreen = 'review';
             }
           }
        });
        return;
      }

      item.uploading = true;
      this.api.saveImage(this.enrollment.cattleId, item.type, blob).subscribe({
        next: (response) => {
          item.previewUrl = response.cloudinaryUrl || this.api.mediaUrl(response.previewUrl);
          item.uploading = false;
          if (navigator.vibrate) navigator.vibrate(100);
          this.playBeep(true);

          // Find next un-captured evidence
          const nextIndex = this.requiredImages.findIndex((img, idx) => idx > this.evidenceCameraIndex && !img.previewUrl);
          if (nextIndex >= 0) {
            this.evidenceCameraIndex = nextIndex;
            this.message = `${item.label} saved! Now point camera at: ${this.requiredImages[nextIndex].label}`;
          } else {
            this.evidenceCameraActive = false;
            this.stopCamera();
            this.message = 'All evidence photos captured! Review your record.';
            if (this.muzzlePreviews.length >= this.muzzleImageCount) {
              this.agentScreen = 'review';
            }
          }
        },
        error: (error) => {
          item.uploading = false;
          this.message = `Evidence upload error: ${this.errorMessage(error)}`;
        }
      });
    } catch {
      this.message = 'Could not capture evidence photo from camera.';
    }
  }

  skipEvidencePhoto(): void {
    const nextIndex = this.requiredImages.findIndex((img, idx) => idx > this.evidenceCameraIndex && !img.previewUrl);
    if (nextIndex >= 0) {
      this.evidenceCameraIndex = nextIndex;
      this.message = `Skipped. Now point camera at: ${this.requiredImages[nextIndex].label}`;
    } else {
      this.evidenceCameraActive = false;
      this.stopCamera();
      this.message = 'Evidence capture finished.';
    }
  }

  stopEvidenceCamera(): void {
    this.evidenceCameraActive = false;
    this.stopCamera();
    this.message = 'Evidence camera stopped. You can still use file picker for remaining photos.';
  }

  async manualSync(): Promise<void> {
    if (!navigator.onLine) {
      this.message = 'Still offline. Cannot sync now.';
      return;
    }
    this.message = 'Syncing pending captures...';
    const result = await this.syncService.syncAll();
    this.pendingSyncCount = this.syncService.pendingCount;
    if (result.synced > 0) {
      this.message = `Synced ${result.synced} capture(s). ${result.failed > 0 ? result.failed + ' failed.' : ''}`;
      this.loadCattleInventory();
    } else if (result.failed > 0) {
      this.message = `${result.failed} capture(s) failed to sync. Will retry when connection improves.`;
    } else {
      this.message = 'No pending captures to sync.';
    }
  }

  private applyMatchResolution(resolution: MuzzleMatchResolution): void {
    this.matchResolution = resolution;
    this.enrollment = resolution.enrollment;
    this.cattleId = resolution.enrollment.cattleId;
    this.refreshMuzzlePreviewsFromEnrollment(resolution.enrollment);

    if (resolution.decision === 'matched_existing') {
      const bestMatch = resolution.topMatches?.[0];
      const source = this.matchSourceLabel(bestMatch?.searchScope);
      const owner = bestMatch?.farmerName ? ` under farmer ${bestMatch.farmerName}` : '';
      const cow = bestMatch?.cattleLabel || this.shortId(resolution.matchedCattleId || resolution.enrollment.cattleId);
      this.loadCattleInventory();
      if (resolution.enrollment.workflow === 'cattle_enrolment') {
        this.message = `This cow already exists${owner} (${cow}). Do not enrol it again; use Cattle Search for repeat testing.`;
        return;
      }
      this.message = `Cattle search matched in ${source}${owner} (${cow}). This search record is saved separately for testing.`;
      return;
    }

    this.loadCattleInventory();
    this.message = 'No enrolled cattle found in selected farmer cattle or all saved muzzle records. This search can be confirmed as correct no-cattle-found if the cow is new.';
  }
  private refreshMuzzlePreviewsFromEnrollment(enrollment: Enrollment): void {
    const session = enrollment.sessions?.find((item) => item.sessionId === enrollment.activeSessionId) || enrollment.sessions?.at(-1);
    if (!session?.images) return;

    const previews = Array.from({ length: this.muzzleImageCount }, (_, index) => session.images?.[`muzzle${index + 1}`]?.previewUrl)
      .filter((preview): preview is string => Boolean(preview))
      .map((preview) => ({ url: this.api.mediaUrl(preview) }));

    if (previews.length === this.muzzleImageCount) {
      this.muzzlePreviews = previews;
    }
  }

  selectAdminCattle(cattle: CattleSummary): void {
    this.selectedAdminCattle = cattle;
  }

  shortId(id?: string | null): string {
    if (!id) return 'NA';
    return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
  }

  matchSourceLabel(scope?: 'farmer_cattle' | 'all_other_muzzle'): string {
    return scope === 'farmer_cattle' ? 'selected farmer cattle records' : 'all saved muzzle records';
  }
  openImage(title: string, url?: string | null): void {
    if (!url) return;
    this.imageViewer = { title, url: this.api.mediaUrl(url) };
  }

  closeImageViewer(): void {
    this.imageViewer = undefined;
  }

  imageUrl(image: CattleImageSummary): string {
    return image.cloudinaryUrl || this.api.mediaUrl(image.previewUrl);
  }

  toggleCattleSelection(cattle: CattleSummary): void {
    if (this.selectedCattleIds.includes(cattle.cattleId)) {
      this.selectedCattleIds = this.selectedCattleIds.filter((id) => id !== cattle.cattleId);
      return;
    }

    this.selectedCattleIds = [...this.selectedCattleIds, cattle.cattleId];
  }

  isCattleSelected(cattle: CattleSummary): boolean {
    return this.selectedCattleIds.includes(cattle.cattleId);
  }
  mergeSelectedIntoMainCattle(): void {
    if (!this.selectedAdminCattle) {
      this.message = 'Select the correct registered cattle row first.';
      return;
    }

    const sourceCattleIds = this.selectedCattleIds.filter((id) => id !== this.selectedAdminCattle?.cattleId);
    if (!sourceCattleIds.length) {
      this.message = 'Tick cattle search or extra cattle rows to merge into the selected registered cattle record.';
      return;
    }

    const ok = window.confirm(`Merge ${sourceCattleIds.length} selected cattle/search record(s) into ${this.shortId(this.selectedAdminCattle.cattleId)}?`);
    if (!ok) return;

    this.message = 'Merging selected cattle/search records...';
    this.api.mergeCattleRecords(this.selectedAdminCattle.cattleId, sourceCattleIds).subscribe({
      next: ({ target, mergedCattleIds }) => {
        this.selectedCattleIds = [];
        this.selectedAdminCattle = target;
        this.message = `Merged ${mergedCattleIds.length} selected record(s). Registered cattle now has ${target.sessionCount} captures.`;
        this.loadCattleInventory();
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  private updateOfficerNamesForFilter(): void {
    const officers = new Set<string>();
    for (const r of this.allMatchReviews) {
      if (r.fieldOfficerName) officers.add(r.fieldOfficerName);
    }
    this.officerNamesForFilter = Array.from(officers).sort();
  }

  loadMatchedCattleImages(cattleId: string, silent = false): void {
    if (this.loadedMatchedImages[cattleId]) return;
    const cattle = this.cattleInventory.find((item) => item.cattleId === cattleId);
    const images = cattle?.sessions?.flatMap((session) => session.images || []) || [];

    if (images.length) {
      this.loadedMatchedImages[cattleId] = images;
      if (!silent) this.message = 'Matched cattle images loaded.';
    } else if (!silent) {
      this.loadedMatchedImages[cattleId] = [];
      this.message = 'No enrolled images found for this cow. Refresh cattle records and try again.';
    } else {
      this.loadedMatchedImages[cattleId] = [];
    }
  }

  toggleReviewDetails(review: MatchReview): void {
    this.expandedReviewId = this.expandedReviewId === review.auditId ? '' : review.auditId;
    if (this.expandedReviewId) this.preloadReviewCandidateImages(review);
  }

  isReviewExpanded(review: MatchReview): boolean {
    return this.expandedReviewId === review.auditId;
  }

  topReviewCandidates(review: MatchReview, limit = 20): MatchReview['topMatches'] {
    return this.metricTopMatches(review).slice(0, limit);
  }

  candidateMuzzleImages(cattleId: string): CattleImageSummary[] {
    return this.candidateImages(cattleId).filter((image) => /^muzzle\d+$/i.test(image.imageType));
  }

  candidateEvidenceImages(cattleId: string): CattleImageSummary[] {
    const order = ['face1', 'face2', 'face3', 'leftside', 'rightside', 'back', 'udder'];
    return this.candidateImages(cattleId)
      .filter((image) => order.includes(image.imageType))
      .sort((a, b) => order.indexOf(a.imageType) - order.indexOf(b.imageType));
  }

  private candidateImages(cattleId: string): CattleImageSummary[] {
    if (!this.loadedMatchedImages[cattleId]) this.loadMatchedCattleImages(cattleId, true);
    return this.loadedMatchedImages[cattleId] || [];
  }

  private preloadExpandedReviewImages(): void {
    const review = this.matchReviews.find((item) => item.auditId === this.expandedReviewId);
    if (review) this.preloadReviewCandidateImages(review);
  }

  private preloadReviewCandidateImages(review: MatchReview): void {
    for (const candidate of this.topReviewCandidates(review, 5)) {
      this.loadMatchedCattleImages(candidate.cattleId, true);
    }
  }

  exportReviewsCsv(): void {
    if (!this.matchReviews.length) return;
    const headers = ['Cattle ID', 'Date', 'Officer', 'Farmer', 'App Decision', 'Review Status', 'Top Match ID', 'Confidence', 'Capture Seconds', 'App Version', 'DINOv2 Model', 'TFLite Model', 'Correct?'];
    const rows = this.matchReviews.map(r => {
      return [
        r.finalCattleId,
        new Date(r.captureDate).toISOString(),
        r.fieldOfficerName || 'NA',
        r.farmerName || 'NA',
        r.decision,
        r.reviewStatus || 'pending',
        r.topMatches?.[0]?.cattleId || '',
        r.topMatches?.[0]?.confidencePercent || '',
        r.captureDurationSeconds || '',
        r.appVersion || '',
        r.dinov2ModelVersion || '',
        r.tfliteMuzzleModelVersion || '',
        this.reviewResultLabel(r)
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
    });
    const csvContent = headers.join(',') + "\n" + rows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const encodedUri = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `vacapay_reviews_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(encodedUri);
  }

  downloadSelectedImages(): void {
    if (!this.selectedCattleIds.length) {
      this.message = 'Select one or more cattle to download.';
      return;
    }

    this.message = 'Preparing ZIP download...';
    this.api.downloadCattleZip(this.selectedCattleIds).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `vacapay-cattle-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        this.message = `ZIP downloaded for ${this.selectedCattleIds.length} selected cattle.`;
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  setAdminRegistryView(view: 'unique' | 'duplicates'): void {
    this.adminRegistryView = view;
    this.selectedCattleIds = [];
    this.selectedAdminCattle = view === 'unique' ? this.uniqueCattleInventory[0] : this.duplicateCattleInventory[0];
  }

  isDuplicateEvidence(cattle?: CattleSummary | null): boolean {
    return Boolean(cattle?.isDuplicateEvidence);
  }

  get uniqueCattleInventory(): CattleSummary[] {
    return this.cattleInventory.filter((cattle) => !this.isDuplicateEvidence(cattle));
  }

  get duplicateCattleInventory(): CattleSummary[] {
    return this.cattleInventory.filter((cattle) => this.isDuplicateEvidence(cattle));
  }

  get visibleCattleInventory(): CattleSummary[] {
    return this.adminRegistryView === 'duplicates' ? this.duplicateCattleInventory : this.uniqueCattleInventory;
  }

  get fieldTestMetrics(): FieldTestMetrics {
    const reviews = this.allMatchReviews.filter((review) => this.isCattleSearchCandidate(review));
    const reviewed = reviews.filter((review) => this.isReviewedCattleSearch(review));
    const cattleFoundResults = reviews.filter((review) => review.decision === 'matched_existing').length;
    const noCattleFoundResults = reviews.filter((review) => review.decision === 'new_cattle').length;
    const cattleFoundCorrect = reviewed.filter((review) => this.isCattleFoundCorrect(review)).length;
    const cattleFoundIncorrect = reviewed.filter((review) => this.isCattleFoundIncorrect(review)).length;
    const noCattleFoundCorrect = reviewed.filter((review) => this.isNoCattleFoundCorrect(review)).length;
    const noCattleFoundIncorrect = reviewed.filter((review) => this.isNoCattleFoundIncorrect(review)).length;
    const top1Correct = reviewed.filter((review) => this.isTopKCorrect(review, 1)).length;
    const top5Correct = reviewed.filter((review) => this.isTopKCorrect(review, 5)).length;

    return {
      registeredCattle: this.cattleStats?.uniqueCattleCount || this.cattleStats?.cattleCount || 0,
      cattleSearches: reviews.length,
      reviewedSearches: reviewed.length,
      cattleFoundResults,
      cattleFoundCorrect,
      cattleFoundIncorrect,
      noCattleFoundResults,
      noCattleFoundCorrect,
      noCattleFoundIncorrect,
      top1Accuracy: this.percent(top1Correct, reviewed.length),
      top5Accuracy: this.percent(top5Correct, reviewed.length),
      pendingReview: reviews.filter((review) => !this.isReviewedCattleSearch(review)).length
    };
  }

  get officerFieldSummaries(): OfficerFieldSummary[] {
    const groups = new Map<string, MatchReview[]>();
    for (const review of this.allMatchReviews) {
      const officer = review.fieldOfficerName || 'Unknown officer';
      groups.set(officer, [...(groups.get(officer) || []), review]);
    }

    return Array.from(groups.entries())
      .map(([officer, reviews]) => {
        const searchReviews = reviews.filter((review) => this.isCattleSearchCandidate(review));
        const reviewed = searchReviews.filter((review) => this.isReviewedCattleSearch(review));
        const cattleFoundCorrect = reviewed.filter((review) => this.isCattleFoundCorrect(review)).length;
        const cattleFoundIncorrect = reviewed.filter((review) => this.isCattleFoundIncorrect(review)).length;
        const noCattleFoundCorrect = reviewed.filter((review) => this.isNoCattleFoundCorrect(review)).length;
        const noCattleFoundIncorrect = reviewed.filter((review) => this.isNoCattleFoundIncorrect(review)).length;
        const top1Correct = reviewed.filter((review) => this.isTopKCorrect(review, 1)).length;
        const top5Correct = reviewed.filter((review) => this.isTopKCorrect(review, 5)).length;
        const avgScore = this.percent(searchReviews.reduce((total, review) => total + Number(review.confidence || 0), 0), searchReviews.length);

        return {
          officer,
          cattleSearches: searchReviews.length,
          reviewedSearches: reviewed.length,
          cattleFoundCorrect,
          cattleFoundIncorrect,
          noCattleFoundCorrect,
          noCattleFoundIncorrect,
          top1Accuracy: this.percent(top1Correct, reviewed.length),
          top5Accuracy: this.percent(top5Correct, reviewed.length),
          avgScore,
          captureQuality: this.captureQualityLabel(avgScore)
        };
      })
      .sort((a, b) => b.reviewedSearches - a.reviewedSearches || b.cattleSearches - a.cattleSearches || a.officer.localeCompare(b.officer));
  }

  isCattleSearchCandidate(review: MatchReview): boolean {
    return review.workflow === 'cattle_search' && (review.decision === 'matched_existing' || review.decision === 'new_cattle');
  }

  isReviewedCattleSearch(review: MatchReview): boolean {
    return this.isCattleSearchCandidate(review) && [
      'confirmed',
      'found_correct',
      'found_incorrect',
      'no_cattle_correct',
      'no_cattle_incorrect',
      'wrong_moved_to_registered'
    ].includes(review.reviewStatus);
  }
  expectedCattleId(review: MatchReview): string | null {
    return review.correctCattleId || null;
  }

  isCorrectMatchedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'matched_existing' && review.matchedCattleId === expected);
  }

  isCorrectNoCattleFoundReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'new_cattle' && expected === review.finalCattleId);
  }

  isMissedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'new_cattle' && expected !== review.finalCattleId);
  }

  isWrongMatchedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'matched_existing' && review.matchedCattleId && review.matchedCattleId !== expected);
  }

  isCattleFoundCorrect(review: MatchReview): boolean {
    return review.reviewStatus === 'found_correct' || this.isCorrectMatchedReview(review);
  }

  isCattleFoundIncorrect(review: MatchReview): boolean {
    return review.reviewStatus === 'found_incorrect' || review.reviewStatus === 'wrong_moved_to_registered' || this.isWrongMatchedReview(review);
  }

  isNoCattleFoundCorrect(review: MatchReview): boolean {
    return review.reviewStatus === 'no_cattle_correct' || this.isCorrectNoCattleFoundReview(review);
  }

  isNoCattleFoundIncorrect(review: MatchReview): boolean {
    return review.reviewStatus === 'no_cattle_incorrect' || this.isMissedReview(review);
  }

  isTopKCorrect(review: MatchReview, k: number): boolean {
    const expected = this.expectedCattleId(review);
    if (!expected) return false;
    return this.metricTopMatches(review).slice(0, k).some((match) => match.cattleId === expected);
  }

  metricTopMatches(review: MatchReview): MatchReview['topMatches'] {
    return review.rankedTopMatches?.length ? review.rankedTopMatches : review.topMatches;
  }

  reviewResultLabel(review: MatchReview): string {
    if (this.isCattleFoundCorrect(review)) return 'Cattle found correct';
    if (this.isCattleFoundIncorrect(review)) return 'Cattle found incorrect';
    if (this.isNoCattleFoundCorrect(review)) return 'No cattle found correct';
    if (this.isNoCattleFoundIncorrect(review)) return 'No cattle found incorrect';
    if (!this.expectedCattleId(review)) return 'Needs admin review';
    if (this.isCorrectMatchedReview(review)) return 'Correct match';
    if (this.isCorrectNoCattleFoundReview(review)) return 'Correct no cattle found';
    if (this.isMissedReview(review)) return 'Missed';
    if (this.isWrongMatchedReview(review)) return 'Wrong';
    if (this.isTopKCorrect(review, 5)) return 'In Top 5';
    return 'Check';
  }

  percent(numerator: number, denominator: number): number {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  captureQualityLabel(scorePercent: number): string {
    if (scorePercent >= 85) return 'Good';
    if (scorePercent >= 70) return 'Medium';
    return 'Needs work';
  }
  get ownerRecordGroups(): Array<{ key: string; label: string; count: number; captures: number }> {
    const groups = new Map<string, { key: string; label: string; count: number; captures: number }>();
    for (const cattle of this.uniqueCattleInventory) {
      const key = (cattle.farmerId || cattle.farmerName || 'unknown').trim().toLowerCase();
      const label = cattle.farmerName || cattle.farmerId || 'Unknown farmer';
      const group = groups.get(key) || { key, label, count: 0, captures: 0 };
      group.count += 1;
      group.captures += cattle.sessionCount;
      groups.set(key, group);
    }
    return Array.from(groups.values()).filter((group) => group.count > 1).sort((a, b) => b.count - a.count);
  }

  get mergeSourceCount(): number {
    if (!this.selectedAdminCattle) return 0;
    return this.selectedCattleIds.filter((id) => id !== this.selectedAdminCattle?.cattleId).length;
  }
  get selectedImageCount(): number {
    return this.cattleInventory
      .filter((cattle) => this.selectedCattleIds.includes(cattle.cattleId))
      .reduce((total, cattle) => total + cattle.imageCount, 0);
  }

  get recentCattle(): CattleSummary[] {
    return this.uniqueCattleInventory.slice(0, 5);
  }

  get hasGps(): boolean {
    return this.locationLat !== null && this.locationLon !== null;
  }

  get canStartExistingFarmerCapture(): boolean {
    return this.hasGps && Boolean(this.selectedFarmerKey) && Boolean(this.farmerId.trim() || this.farmerName.trim());
  }

  get registeredCattleCount(): number {
    return this.cattleStats?.uniqueCattleCount || this.cattleStats?.cattleCount || this.uniqueCattleInventory.length || 0;
  }

  get isCattleSearchFlow(): boolean {
    return this.captureWorkflow === 'cattle_search';
  }

  get locationPrimaryActionLabel(): string {
    if (!this.selectedFarmerKey) return 'Select Farmer First';
    if (!this.hasGps) return 'Use GPS First';
    return this.isCattleSearchFlow ? 'Start Cattle Search' : 'Add New Cow Under Selected Farmer';
  }

  get farmerNavTarget(): AgentScreen {
    if (this.agentScreen === 'home') return 'farmer';
    if (this.isCattleSearchFlow || this.selectedFarmerKey || this.enrollment) return 'location';
    return 'farmer';
  }

  get farmerNavLabel(): string {
    return this.isCattleSearchFlow ? 'Find' : 'Farmer';
  }

  get completeButtonLabel(): string {
    return this.isCattleSearchFlow ? 'Save Cattle Search Result' : 'Save Registered Cow';
  }

  get locationPrimaryHelp(): string {
    return this.isCattleSearchFlow
      ? 'This saves a cattle search record only. It checks this farmer first, then all registered cattle.'
      : 'This saves a new registered cattle identity under the selected farmer.';
  }

  get canComplete(): boolean {
    return this.muzzlePreviews.length === this.muzzleImageCount && this.requiredImages.every((item) => item.previewUrl);
  }

  get capturedOtherImages(): number {
    return this.requiredImages.filter((item) => item.previewUrl).length;
  }

  get totalCapturedImages(): number {
    return this.muzzlePreviews.length + this.capturedOtherImages;
  }

  get progressPercent(): number {
    return Math.round((this.totalCapturedImages / this.totalImageCount) * 100);
  }

  get enrollmentStage(): string {
    if (!this.enrollment) return 'Not Started';
    if (this.canComplete) return 'Ready';
    if (this.totalCapturedImages > 0) return 'Capturing';
    return 'Draft';
  }

  get nextAction(): string {
    if (!this.enrollment) return 'Find Existing Or Create';
    if (this.muzzlePreviews.length < this.muzzleImageCount) return `Capture muzzle ${this.muzzlePreviews.length + 1}`;
    if (this.capturedOtherImages < this.requiredImages.length) return 'Complete image checklist';
    return 'Submit enrollment';
  }

  get isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
  }

  get isAgent(): boolean {
    return this.currentUser?.role === 'agent';
  }

  get faceCount(): number {
    return this.requiredImages.filter((item) => item.group === 'Face' && item.previewUrl).length;
  }

  get bodyCount(): number {
    return this.requiredImages.filter((item) => item.group === 'Body' && item.previewUrl).length;
  }

  get udderCount(): number {
    return this.requiredImages.filter((item) => item.group === 'Udder' && item.previewUrl).length;
  }

  get agentStepIndex(): number {
    return this.agentScreens.findIndex((step) => step.key === this.agentScreen);
  }

  get agentScreenTitle(): string {
    switch (this.agentScreen) {
      case 'farmer': return 'Owner Details';
      case 'location': return 'Find Farmer';
      case 'muzzle': return 'Muzzle Photos';
      case 'evidence': return 'Other Photos';
      case 'review': return 'Check & Save';
      default: return 'Agent Home';
    }
  }
  get agentScreenSubtitle(): string {
    switch (this.agentScreen) {
      case 'farmer': return 'Add a new farmer or search an existing farmer by GPS/name.';
      case 'location': return 'Find the farmer by name and GPS, then muzzle matching selects the correct cow.';
      case 'muzzle': return `Take ${this.muzzleImageCount} good muzzle photos. Phone muzzle gate rejects bad muzzles, crops the muzzle, applies contrast, then uploads only the crop.`;
      case 'evidence': return 'Add face, side, back and udder photos for the same cattle.';
      case 'review': return 'Check the record once, then save and return home.';
      default: return 'Start capture, continue pending work, or check recent cattle.';
    }
  }
  get activeScreenNumber(): string {
    return String(Math.max(this.agentStepIndex + 1, 1)).padStart(2, '0');
  }

  get missingMuzzleSlots(): number[] {
    return Array.from({ length: this.muzzleImageCount - this.muzzlePreviews.length }, (_, index) => this.muzzlePreviews.length + index + 1);
  }


  private generateFarmerId(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = new Uint32Array(8);

    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(values);
      return `FARM-${Array.from(values, (value) => alphabet[value % alphabet.length]).join('')}`;
    }

    return `FARM-${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, 'X')}`;
  }
  private frameBlob(): Promise<Blob> {
    const video = this.video!.nativeElement;
    const canvas = this.canvas!.nativeElement;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available.');
    context.drawImage(video, 0, 0, width, height);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not capture camera frame.'));
      }, 'image/jpeg', 0.9);
    });
  }

  private resetCaptureState(clearOwnerDetails: boolean): void {
    this.stopCamera();
    this.enrollment = undefined;
    this.cattleId = '';
    this.offlineCaptureId = undefined;
    this.captureStartTime = 0;
    this.selectedFarmerKey = '';
    this.farmerMatches = [];
    this.gpsFarmerMatches = [];
    this.nameFarmerMatches = [];
    this.searchingFarmers = false;
    this.searchingGpsFarmers = false;
    this.searchingNameFarmers = false;
    this.cattleMatches = [];
    this.muzzlePreviews = [];
    this.matchResolution = undefined;
    this.lastConfidence = undefined;
    this.detectionBox = undefined;
    this.requiredImages.forEach((item) => {
      item.previewUrl = undefined;
      item.uploading = false;
    });

    if (clearOwnerDetails) {
      this.farmerId = '';
      this.farmerName = '';
      this.farmerSearchQuery = '';
      this.locationLat = null;
      this.locationLon = null;
    }
  }
  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.error?.error) {
      if (Array.isArray(error.error.missing) && error.error.missing.length) {
        return `${error.error.error} Missing on server: ${error.error.missing.join(', ')}. Retake only these photos.`;
      }
      return error.error.error;
    }
    return 'Something went wrong.';
  }

  private prepareMissingImageRetakes(error: unknown): void {
    if (!(error instanceof HttpErrorResponse) || !Array.isArray(error.error?.missing)) return;
    const missing = error.error.missing.map((file: unknown) => String(file));
    const missingTypes = new Set(missing.map((file: string) => file.replace(/\.jpg$/i, '')));
    const hasMissingMuzzle = missing.some((file: string) => /^muzzle\d+\.jpg$/i.test(file));

    this.requiredImages.forEach((item) => {
      if (missingTypes.has(item.type)) item.previewUrl = undefined;
    });

    if (hasMissingMuzzle) {
      this.muzzlePreviews.forEach((preview) => {
        if (preview.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
      });
      this.muzzlePreviews = [];
      this.agentScreen = 'muzzle';
      return;
    }

    if (missing.length) {
      this.agentScreen = 'evidence';
      this.evidenceCameraActive = false;
      this.evidenceCameraIndex = this.requiredImages.findIndex((item) => !item.previewUrl);
    }
  }

  private toDetectionBox(bbox: number[] | undefined, imageSize: number[] | undefined, confidence: number): DetectionBox | undefined {
    if (!bbox || !imageSize || bbox.length < 4 || imageSize.length < 2) return undefined;

    const [x1, y1, x2, y2] = bbox;
    const [imageWidth, imageHeight] = imageSize;
    if (!imageWidth || !imageHeight) return undefined;

    return {
      left: (x1 / imageWidth) * 100,
      top: (y1 / imageHeight) * 100,
      width: ((x2 - x1) / imageWidth) * 100,
      height: ((y2 - y1) / imageHeight) * 100,
      confidence
    };
  }
}
