import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, AppUser, CattleMatch, EmbeddingStatus, Enrollment, MatchReview, MuzzleMatchResolution, PineconeStatus, YoloStatus } from './api.service';

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
  cattleMatches: CattleMatch[] = [];
  searchingCattle = false;

  muzzlePreviews: string[] = [];
  cameraOn = false;
  autoCaptureOn = false;
  isDetecting = false;
  message = 'Create enrollment to start.';
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
    { key: 'farmer', label: 'Farmer', caption: 'Details' },
    { key: 'location', label: 'GPS', caption: 'Nearby cows' },
    { key: 'muzzle', label: 'Muzzle', caption: 'AI capture' },
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
        } else {
          this.loadAgents();
          this.loadMatchReviews();
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
    this.message = 'Signed out.';
  }

  goAgentScreen(screen: AgentScreen): void {
    if (screen === 'muzzle' && !this.enrollment) {
      this.message = 'Create a cattle session before muzzle capture.';
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
    this.agentScreen = 'farmer';
    this.message = 'Enter farmer details, then continue to GPS.';
  }

  continueToLocation(): void {
    this.agentScreen = 'location';
    this.message = 'Use GPS and search nearby registered cattle before creating the session.';
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

  loadMatchReviews(): void {
    this.api.listMatchReviews(!this.showAllReviews).subscribe({
      next: ({ reviews }) => {
        this.matchReviews = reviews;
      },
      error: (error) => {
        this.message = this.errorMessage(error);
      }
    });
  }

  toggleReviewMode(): void {
    this.showAllReviews = !this.showAllReviews;
    this.loadMatchReviews();
  }

  confirmMatchReview(review: MatchReview, correctCattleId?: string): void {
    this.api
      .updateMatchReview(review.auditId, {
        reviewStatus: 'confirmed',
        correctCattleId: correctCattleId || review.matchedCattleId || review.finalCattleId,
        reviewNotes: correctCattleId ? 'Corrected by admin.' : 'Confirmed by admin.'
      })
      .subscribe({
        next: ({ review: updated }) => {
          this.matchReviews = this.matchReviews.map((item) => item.auditId === updated.auditId ? updated : item);
          this.message = `Review saved for ${updated.finalCattleId}.`;
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
    this.message = 'Creating enrollment...';
    this.api
      .createEnrollment({
        cattleId: this.cattleId,
        farmerId: this.farmerId,
        farmerName: this.farmerName,
        fieldOfficerName: this.currentUser?.name || this.fieldOfficerName,
        fieldOfficerId: this.currentUser?.agentId,
        locationLat: this.locationLat,
        locationLon: this.locationLon
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
          this.message = `Enrollment ready: ${enrollment.cattleId}. Start muzzle capture.`;
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

  findRegisteredCattle(): void {
    this.searchingCattle = true;
    this.message = 'Searching already registered cattle nearby...';
    this.api
      .searchRegisteredCattle({
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
            ? `Found ${cattle.length} registered cattle near this farmer/location.`
            : 'No registered cattle found for this farmer and radius.';
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
    this.message = `Candidate noted: ${match.cattleId}. DINOv2 will decide after 5 muzzle captures.`;
  }

  async startCamera(): Promise<void> {
    if (!this.enrollment) {
      this.message = 'Create enrollment first.';
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
    this.message = `Checking muzzle ${slot}/5 with YOLO...`;
    const blob = await this.frameBlob();

    this.api.captureMuzzle(this.enrollment.cattleId, blob, slot).subscribe({
      next: (response) => {
        this.lastConfidence = response.result.confidence;
        this.detectionBox = this.toDetectionBox(response.result.bbox, response.result.imageSize, response.result.confidence);
        this.muzzlePreviews.push(this.api.mediaUrl(response.previewUrl));
        this.message = `YOLO detected muzzle. Captured ${slot}/5. CLAHE applied.`;
        this.isDetecting = false;

        if (response.matchResolution) {
          this.applyMatchResolution(response.matchResolution);
        }

        if (this.muzzlePreviews.length >= 5 && this.autoCaptureOn) {
          this.toggleAutoCapture();
          if (!response.matchResolution) {
            this.message = 'All 5 muzzle images captured. DINOv2 matching is pending.';
          }
          this.agentScreen = 'evidence';
        }
      },
      error: (error) => {
        this.detectionBox = undefined;
        this.message = error.status === 422
          ? `YOLO did not detect clear muzzle for ${slot}/5. Hold steady and show full muzzle.`
          : `YOLO/backend error: ${this.errorMessage(error)}`;
        this.isDetecting = false;
      }
    });
  }

  uploadRequiredImage(event: Event, item: RequiredImage): void {
    if (!this.enrollment) {
      this.message = 'Create enrollment first.';
      return;
    }

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    item.uploading = true;
    this.api.saveImage(this.enrollment.cattleId, item.type, file).subscribe({
      next: (response) => {
        item.previewUrl = this.api.mediaUrl(response.previewUrl);
        item.uploading = false;
        this.message = `${item.label} saved.`;
        if (this.capturedOtherImages === this.requiredImages.length && this.muzzlePreviews.length === 5) {
          this.agentScreen = 'review';
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
        this.agentScreen = 'review';
        this.message = 'Capture session complete and ready for embedding service.';
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
      this.message = `DINOv2 matched existing cattle ${resolution.matchedCattleId} with ${resolution.confidencePercent}% confidence. Continue supporting images.`;
      return;
    }

    this.message = `DINOv2 did not cross ${resolution.thresholdPercent}%. New cattle ID kept: ${resolution.enrollment.cattleId}.`;
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
      case 'farmer': return 'Farmer Details';
      case 'location': return 'Location Match';
      case 'muzzle': return 'Muzzle Capture';
      case 'evidence': return 'Evidence Capture';
      case 'review': return 'Final Review';
      default: return 'Field Home';
    }
  }

  get agentScreenSubtitle(): string {
    switch (this.agentScreen) {
      case 'farmer': return 'Enter farmer and officer details for this cattle visit.';
      case 'location': return 'Search the farmer list within 5-7 km before creating a new session.';
      case 'muzzle': return 'YOLO detects the muzzle, crops it, applies CLAHE, and saves 5 images.';
      case 'evidence': return 'Capture face, side, back, and udder images for the same cattle folder.';
      case 'review': return 'Confirm the collected images and matching decision before submit.';
      default: return 'Start a guided cattle enrollment flow.';
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




