import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, AppUser, CattleImageSummary, CattleMatch, CattleStats, CattleSummary, EmbeddingStatus, Enrollment, FarmerMatch, MatchReview, MuzzleMatchResolution, PineconeStatus, YoloStatus } from './api.service';

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
  repeatVisits: number;
  reviewedVisits: number;
  correctMatches: number;
  missedMatches: number;
  wrongMatches: number;
  top1Accuracy: number;
  top5Accuracy: number;
  falseMatchCount: number;
  pendingTruth: number;
}

interface OfficerFieldSummary {
  officer: string;
  repeatVisits: number;
  reviewedVisits: number;
  correctMatches: number;
  missedMatches: number;
  wrongMatches: number;
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
export class AppComponent implements OnDestroy {
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
  agentName = '';
  agentPhone = '';
  newAgentId = '';
  newAgentPassword = '';

  enrollment?: Enrollment;
  cattleId = '';
  farmerId = '';
  farmerName = '';
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

  muzzlePreviews: string[] = [];
  cameraOn = false;
  autoCaptureOn = false;
  isDetecting = false;
  message = 'Start a new cattle capture.';
  lastConfidence?: number;
  detectionBox?: DetectionBox;
  yoloStatus?: YoloStatus;
  embeddingStatus?: EmbeddingStatus;
  pineconeStatus?: PineconeStatus;
  matchResolution?: MuzzleMatchResolution;
  checkingYolo = false;
  checkingEmbedding = false;
  checkingPinecone = false;
  agentScreen: AgentScreen = 'home';

  readonly agentScreens: AgentStep[] = [
    { key: 'home', label: 'Home', caption: 'Start' },
    { key: 'farmer', label: 'Owner', caption: 'Details' },
    { key: 'location', label: 'Nearby', caption: 'Check' },
    { key: 'muzzle', label: 'Muzzle', caption: '5 photos' },
    { key: 'evidence', label: 'Evidence', caption: 'Photos' },
    { key: 'review', label: 'Review', caption: 'Finish' }
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

  private stream?: MediaStream;
  private captureTimer?: number;

  constructor(private readonly api: ApiService) {
    const savedUser = localStorage.getItem('vacapay_user');
    if (savedUser) {
      this.currentUser = JSON.parse(savedUser) as AppUser;
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
  }

  login(): void {
    this.message = 'Signing in...';
    this.api.login(this.loginIdentifier, this.loginPassword).subscribe({
      next: ({ token, user }) => {
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
    this.api.yoloStatus().subscribe({
      next: (status) => {
        this.yoloStatus = status;
        this.checkingYolo = false;
        this.message = status.ok ? 'YOLO model is ready.' : `YOLO model not ready: ${status.error || 'Unknown error'}`;
      },
      error: (error) => {
        this.checkingYolo = false;
        this.yoloStatus = {
          ok: false,
          modelPath: '',
          error: this.errorMessage(error)
        };
        this.message = `YOLO model not ready: ${this.yoloStatus.error}`;
      }
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

    if ((screen === 'evidence' || screen === 'review') && this.muzzlePreviews.length < 5) {
      this.message = 'Capture all 5 muzzle images before moving ahead.';
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
  }

  startNewFarmerMode(): void {
    this.resetCaptureState(true);
    this.agentScreen = 'farmer';
    this.message = 'Add farmer details, then start the first cow capture.';
  }

  startExistingFarmerSearch(): void {
    this.resetCaptureState(true);
    this.agentScreen = 'location';
    this.message = 'Use GPS first, then search and select an existing farmer.';
  }

  startNewEnrollment(): void {
    this.startNewFarmerMode();
  }

  startNewFarmerCapture(): void {
    if (!this.farmerId.trim() && !this.farmerName.trim()) {
      this.message = 'Enter farmer ID or farmer name before adding a new farmer.';
      return;
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
    this.farmerId = cattle.farmerId || '';
    this.farmerName = cattle.farmerName || '';
    this.message = 'Owner details loaded. Start a fresh capture for this cattle.';
    this.agentScreen = 'farmer';
  }

  continueToLocation(): void {
    if (!this.farmerId.trim() && !this.farmerName.trim()) {
      this.message = 'Farmer ID or farmer name is required before GPS check.';
      return;
    }

    this.agentScreen = 'location';
    this.message = 'Use GPS or name search. Select the farmer, then capture muzzle for the cow.';
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
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  loadMatchReviews(): void {
    this.api.listMatchReviews(false).subscribe({
      next: ({ reviews }) => {
        this.allMatchReviews = reviews;
        this.applyReviewFilter();
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  applyReviewFilter(): void {
    this.matchReviews = this.showAllReviews
      ? this.allMatchReviews
      : this.allMatchReviews.filter((review) => !this.isClosedReview(review));
  }

  isClosedReview(review: MatchReview): boolean {
    return ['confirmed', 'wrong_moved_to_registered'].includes(review.reviewStatus);
  }

  toggleReviewMode(): void {
    this.showAllReviews = !this.showAllReviews;
    this.applyReviewFilter();
  }

  confirmMatchReview(review: MatchReview, correctCattleId?: string): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'confirmed',
        correctCattleId: correctCattleId || review.matchedCattleId || review.finalCattleId,
        reviewNotes: correctCattleId ? 'Expected cow corrected by admin.' : 'Photo review confirmed correct.'
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

  moveWrongMatchToRegistered(review: MatchReview): void {
    const ok = window.confirm('Move this capture out of matched re-visits and keep it as a registered cattle record?');
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
    if (!this.farmerId.trim() && !this.farmerName.trim()) {
      this.message = 'Farmer ID or farmer name is required before starting capture.';
      return;
    }

    if (!this.hasGps) {
      this.message = 'Use GPS first before starting cow capture.';
      return;
    }

    this.message = 'Starting capture session...';
    this.api
      .createEnrollment({
        farmerId: this.farmerId.trim(),
        farmerName: this.farmerName.trim(),
        fieldOfficerName: this.currentUser?.name || this.fieldOfficerName,
        fieldOfficerId: this.currentUser?.agentId,
        locationLat: this.locationLat,
        locationLon: this.locationLon,
        matchRadiusKm: this.radiusKm
      })
      .subscribe({
        next: ({ enrollment }) => {
          this.enrollment = enrollment;
          this.cattleId = enrollment.cattleId;
          this.muzzlePreviews = [];
          this.matchResolution = undefined;
          this.requiredImages.forEach((item) => {
            item.previewUrl = undefined;
            item.uploading = false;
          });
          this.agentScreen = 'muzzle';
          this.message = enrollment.autoSelectedExistingCattle
            ? 'Existing cattle folder found. This visit will save under today date.'
            : 'Capture session ready. Start muzzle photos. The app will search farmer cattle and all saved muzzle records.';
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

    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.locationLat = Number(position.coords.latitude.toFixed(6));
        this.locationLon = Number(position.coords.longitude.toFixed(6));
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
            : 'No farmers found near this GPS. Try name search or add a new farmer.';
        },
        error: (error) => {
          this.searchingFarmers = false;
          this.searchingGpsFarmers = false;
          this.message = this.errorMessage(error);
        }
      });
  }

  findFarmersByName(): void {
    const q = (this.farmerName || this.farmerId).trim();
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
            : 'No farmer found by that name/ID. Use GPS search or add a new farmer.';
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
            : 'No saved cows found for this farmer. Start capture to enroll the first cow.';
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });

      if (this.video?.nativeElement) {
        this.video.nativeElement.srcObject = this.stream;
        await this.video.nativeElement.play();
      }

      this.cameraOn = true;
      this.message = 'Camera ready. Start auto capture when muzzle is visible.';
    } catch (error) {
      const cameraError = error instanceof DOMException ? error.name : '';
      if (cameraError === 'NotAllowedError') {
        this.message = 'Camera permission denied. Allow camera permission in browser site settings.';
        return;
      }

      if (cameraError === 'NotFoundError') {
        this.message = 'No camera was found on this device.';
        return;
      }

      this.message = 'Camera could not start. Use HTTPS and allow camera permission.';
    }
  }

  stopCamera(): void {
    window.clearInterval(this.captureTimer);
    this.captureTimer = undefined;
    this.autoCaptureOn = false;
    this.cameraOn = false;
    this.detectionBox = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  toggleAutoCapture(): void {
    if (this.autoCaptureOn) {
      window.clearInterval(this.captureTimer);
      this.captureTimer = undefined;
      this.autoCaptureOn = false;
      this.message = 'Auto capture paused.';
      return;
    }

    this.autoCaptureOn = true;
    this.message = 'Looking for clear muzzle...';
    this.captureTimer = window.setInterval(() => {
      void this.tryCaptureMuzzle();
    }, 1600);
  }

  async tryCaptureMuzzle(): Promise<void> {
    if (!this.enrollment || !this.video || !this.canvas || this.isDetecting || this.muzzlePreviews.length >= 5) {
      if (this.muzzlePreviews.length >= 5) this.toggleAutoCapture();
      return;
    }

    this.isDetecting = true;
    const slot = this.muzzlePreviews.length + 1;
    this.message = `Checking muzzle photo ${slot}/5...`;
    const blob = await this.frameBlob();

    this.api.captureMuzzle(this.enrollment.cattleId, blob, slot).subscribe({
      next: (response) => {
        this.lastConfidence = response.result.confidence;
        this.detectionBox = this.toDetectionBox(response.result.bbox, response.result.imageSize, response.result.confidence);
        this.muzzlePreviews.push(response.cloudinaryUrl || this.api.mediaUrl(response.previewUrl));
        this.message = `Muzzle photo ${slot}/5 saved.`;
        this.isDetecting = false;

        if (response.matchResolution) {
          this.applyMatchResolution(response.matchResolution);
        }

        if (this.muzzlePreviews.length >= 5 && this.autoCaptureOn) {
          this.toggleAutoCapture();
          if (!response.matchResolution) {
            this.message = 'All 5 muzzle photos captured. Checking farmer cattle and all saved muzzle records.';
          }
          this.agentScreen = 'evidence';
        }
      },
      error: (error) => {
        this.detectionBox = undefined;
        this.message = error.status === 422
          ? `Muzzle was not clear for photo ${slot}/5. Hold steady and show the full muzzle.`
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

    item.uploading = true;
    this.api.saveImage(this.enrollment.cattleId, item.type, file).subscribe({
      next: (response) => {
        item.previewUrl = response.cloudinaryUrl || this.api.mediaUrl(response.previewUrl);
        item.uploading = false;
        this.message = `${item.label} saved.`;
        if (this.capturedOtherImages === this.requiredImages.length && this.muzzlePreviews.length === 5) {
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

    this.api.complete(this.enrollment.cattleId).subscribe({
      next: ({ enrollment }) => {
        this.enrollment = enrollment;
        this.loadCattleInventory();
        this.resetCaptureState(false);
        this.agentScreen = 'home';
        this.message = 'Capture session complete. Returned home for the next cattle.';
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  private applyMatchResolution(resolution: MuzzleMatchResolution): void {
    this.matchResolution = resolution;
    this.enrollment = resolution.enrollment;
    this.cattleId = resolution.enrollment.cattleId;
    this.refreshMuzzlePreviewsFromEnrollment(resolution.enrollment);

    if (resolution.decision === 'matched_existing') {
      const visitCount = resolution.enrollment.sessions?.length || 1;
      const bestMatch = resolution.topMatches?.[0];
      const source = this.matchSourceLabel(bestMatch?.searchScope);
      const owner = bestMatch?.farmerName ? ` under farmer ${bestMatch.farmerName}` : '';
      const cow = bestMatch?.cattleLabel || this.shortId(resolution.matchedCattleId || resolution.enrollment.cattleId);
      this.loadCattleInventory();
      this.message = `Duplicate found in ${source}${owner} (${cow}). This capture is saved in its own separate duplicate folder.`;
      return;
    }

    this.loadCattleInventory();
    this.message = 'No strong match found in selected farmer cattle or all saved muzzle records. A new cattle record is kept.';
  }
  private refreshMuzzlePreviewsFromEnrollment(enrollment: Enrollment): void {
    const session = enrollment.sessions?.find((item) => item.sessionId === enrollment.activeSessionId) || enrollment.sessions?.at(-1);
    if (!session?.images) return;

    const previews = Array.from({ length: 5 }, (_, index) => session.images?.[`muzzle${index + 1}`]?.previewUrl)
      .filter((preview): preview is string => Boolean(preview))
      .map((preview) => this.api.mediaUrl(preview));

    if (previews.length === 5) {
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
      this.message = 'Select the correct main cattle row first.';
      return;
    }

    const sourceCattleIds = this.selectedCattleIds.filter((id) => id !== this.selectedAdminCattle?.cattleId);
    if (!sourceCattleIds.length) {
      this.message = 'Tick duplicate cattle rows to merge into the selected main record.';
      return;
    }

    const ok = window.confirm(`Merge ${sourceCattleIds.length} duplicate cattle record(s) into ${this.shortId(this.selectedAdminCattle.cattleId)}?`);
    if (!ok) return;

    this.message = 'Merging duplicate cattle records...';
    this.api.mergeCattleRecords(this.selectedAdminCattle.cattleId, sourceCattleIds).subscribe({
      next: ({ target, mergedCattleIds }) => {
        this.selectedCattleIds = [];
        this.selectedAdminCattle = target;
        this.message = `Merged ${mergedCattleIds.length} duplicate record(s). Main cattle now has ${target.sessionCount} visits.`;
        this.loadCattleInventory();
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
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
    const reviews = this.allMatchReviews;
    const reviewed = reviews.filter((review) => this.isReviewedRepeatTest(review));
    const correctMatches = reviewed.filter((review) => this.isCorrectMatchedReview(review)).length;
    const missedMatches = reviewed.filter((review) => this.isMissedReview(review)).length;
    const wrongMatches = reviewed.filter((review) => this.isWrongMatchedReview(review)).length;
    const top1Correct = reviewed.filter((review) => this.isTopKCorrect(review, 1)).length;
    const top5Correct = reviewed.filter((review) => this.isTopKCorrect(review, 5)).length;

    return {
      registeredCattle: this.cattleStats?.uniqueCattleCount || this.cattleStats?.cattleCount || 0,
      repeatVisits: reviews.filter((review) => this.isRepeatTestCandidate(review)).length,
      reviewedVisits: reviewed.length,
      correctMatches,
      missedMatches,
      wrongMatches,
      top1Accuracy: this.percent(top1Correct, reviewed.length),
      top5Accuracy: this.percent(top5Correct, reviewed.length),
      falseMatchCount: wrongMatches,
      pendingTruth: reviews.filter((review) => this.isRepeatTestCandidate(review) && !this.expectedCattleId(review)).length
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
        const reviewed = reviews.filter((review) => this.isReviewedRepeatTest(review));
        const correctMatches = reviewed.filter((review) => this.isCorrectMatchedReview(review)).length;
        const missedMatches = reviewed.filter((review) => this.isMissedReview(review)).length;
        const wrongMatches = reviewed.filter((review) => this.isWrongMatchedReview(review)).length;
        const top1Correct = reviewed.filter((review) => this.isTopKCorrect(review, 1)).length;
        const top5Correct = reviewed.filter((review) => this.isTopKCorrect(review, 5)).length;
        const avgScore = this.percent(reviews.reduce((total, review) => total + Number(review.confidence || 0), 0), reviews.length);

        return {
          officer,
          repeatVisits: reviews.filter((review) => this.isRepeatTestCandidate(review)).length,
          reviewedVisits: reviewed.length,
          correctMatches,
          missedMatches,
          wrongMatches,
          top1Accuracy: this.percent(top1Correct, reviewed.length),
          top5Accuracy: this.percent(top5Correct, reviewed.length),
          avgScore,
          captureQuality: this.captureQualityLabel(avgScore)
        };
      })
      .sort((a, b) => b.reviewedVisits - a.reviewedVisits || b.repeatVisits - a.repeatVisits || a.officer.localeCompare(b.officer));
  }

  isRepeatTestCandidate(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return review.decision === 'matched_existing' || Boolean(expected && expected !== review.finalCattleId);
  }

  isReviewedRepeatTest(review: MatchReview): boolean {
    return Boolean(this.expectedCattleId(review) && this.isRepeatTestCandidate(review));
  }
  expectedCattleId(review: MatchReview): string | null {
    return review.correctCattleId || null;
  }

  isCorrectMatchedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'matched_existing' && review.matchedCattleId === expected);
  }

  isMissedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'new_cattle');
  }

  isWrongMatchedReview(review: MatchReview): boolean {
    const expected = this.expectedCattleId(review);
    return Boolean(expected && review.decision === 'matched_existing' && review.matchedCattleId && review.matchedCattleId !== expected);
  }

  isTopKCorrect(review: MatchReview, k: number): boolean {
    const expected = this.expectedCattleId(review);
    if (!expected) return false;
    return review.topMatches.slice(0, k).some((match) => match.cattleId === expected);
  }

  reviewResultLabel(review: MatchReview): string {
    if (!this.expectedCattleId(review)) return 'Needs expected cow';
    if (this.isCorrectMatchedReview(review)) return 'Correct';
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
  get ownerRecordGroups(): Array<{ key: string; label: string; count: number; visits: number }> {
    const groups = new Map<string, { key: string; label: string; count: number; visits: number }>();
    for (const cattle of this.uniqueCattleInventory) {
      const key = (cattle.farmerId || cattle.farmerName || 'unknown').trim().toLowerCase();
      const label = cattle.farmerName || cattle.farmerId || 'Unknown owner';
      const group = groups.get(key) || { key, label, count: 0, visits: 0 };
      group.count += 1;
      group.visits += cattle.sessionCount;
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

  get canComplete(): boolean {
    return this.muzzlePreviews.length === 5 && this.requiredImages.every((item) => item.previewUrl);
  }

  get capturedOtherImages(): number {
    return this.requiredImages.filter((item) => item.previewUrl).length;
  }

  get totalCapturedImages(): number {
    return this.muzzlePreviews.length + this.capturedOtherImages;
  }

  get progressPercent(): number {
    return Math.round((this.totalCapturedImages / 12) * 100);
  }

  get enrollmentStage(): string {
    if (!this.enrollment) return 'Not Started';
    if (this.canComplete) return 'Ready';
    if (this.totalCapturedImages > 0) return 'Capturing';
    return 'Draft';
  }

  get nextAction(): string {
    if (!this.enrollment) return 'Find Existing Or Create';
    if (this.muzzlePreviews.length < 5) return `Capture muzzle ${this.muzzlePreviews.length + 1}`;
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
      case 'muzzle': return 'Take 5 clear muzzle photos. The app checks farmer cattle and all saved muzzle records.';
      case 'evidence': return 'Add face, side, back and udder photos for the same cattle.';
      case 'review': return 'Check the record once, then save and return home.';
      default: return 'Start capture, continue pending work, or check recent cattle.';
    }
  }
  get activeScreenNumber(): string {
    return String(Math.max(this.agentStepIndex + 1, 1)).padStart(2, '0');
  }

  get missingMuzzleSlots(): number[] {
    return Array.from({ length: 5 - this.muzzlePreviews.length }, (_, index) => this.muzzlePreviews.length + index + 1);
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
      this.locationLat = null;
      this.locationLon = null;
    }
  }
  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.error?.error) {
      return error.error.error;
    }
    return 'Something went wrong.';
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
