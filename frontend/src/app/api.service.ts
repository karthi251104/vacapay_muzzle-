import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface Enrollment {
  cattleId: string;
  activeSessionId: string;
  farmerId: string;
  farmerName: string;
  fieldOfficerId: string;
  fieldOfficerName: string;
  locationLat: number | null;
  locationLon: number | null;
  locationAccuracyM?: number | null;
  locationCapturedAt?: string;
  rootFolderLocation: string;
  folderLocation: string;
  captureDateTime: string;
  uploadDateTime: string;
  status: string;
  workflow?: 'cattle_enrolment' | 'cattle_search';
  autoSelectedExistingCattle?: boolean;
  sessions?: CaptureSession[];
}

export interface CaptureSession {
  sessionId: string;
  captureDate: string;
  captureDateTime: string;
  uploadDateTime: string;
  folderLocation: string;
  status: string;
  captureDurationSeconds?: number | null;
  images?: Record<string, CaptureImageRef>;
}

export interface CaptureImageRef {
  imageType: string;
  fileName: string;
  localPath: string;
  previewUrl: string;
  cloudinary?: {
    publicId: string;
    secureUrl: string;
    format: string;
    bytes: number;
    width: number;
    height: number;
  } | null;
  cloudinaryError?: string;
}

export interface MuzzleGateResponse {
  accepted: boolean;
  reason?: string;
  confidence: number;
  sharpness?: number;
  className: string;
  bbox: [number, number, number, number] | null;
  imageSize: [number, number];
  cropBase64?: string;
  source?: 'backend_yolo_pt' | 'backend_tflite';
  backendUnavailable?: boolean;
  error?: string;
}

export interface MuzzleCaptureResponse {
  slot: number;
  savedAs: string;
  previewUrl: string;
  cloudinaryUrl?: string | null;
  matchResolution?: MuzzleMatchResolution | null;
  matchPending?: boolean;
  matchError?: string | null;
  result: {
    detected: boolean;
    confidence: number;
    bbox: number[];
    imageSize: number[];
    claheApplied: boolean;
    imgsz: number;
  };
}

export interface MuzzleMatchResult {
  cattleId: string;
  cattleNumber: number | null;
  cattleLabel: string;
  searchScope?: 'farmer_cattle' | 'nearby_location' | 'outside_location' | 'all_other_muzzle';
  sessionId: string;
  farmerName: string;
  fieldOfficerName: string;
  locationLat: number | null;
  locationLon: number | null;
  distanceKm: number | null;
  score: number;
  confidencePercent: number;
}

export interface FarmerMatchComparison {
  available: boolean;
  farmerId: string;
  farmerName: string;
  candidateCount: number;
  decision: 'matched_existing' | 'new_cattle' | null;
  matchedCattleId: string | null;
  confidence: number;
  confidencePercent: number;
  threshold: number;
  thresholdPercent: number;
  topMatches: MuzzleMatchResult[];
}

export interface MuzzleMatchResolution {
  resolved: boolean;
  decision: 'matched_existing' | 'new_cattle';
  confidence: number;
  confidencePercent: number;
  threshold: number;
  thresholdPercent: number;
  matchedCattleId: string | null;
  previousCattleId?: string;
  topMatches: MuzzleMatchResult[];
  rankedTopMatches?: MuzzleMatchResult[];
  farmerComparison?: FarmerMatchComparison | null;
  resolvedAt: string;
  enrollment: Enrollment;
}

export interface ManualImageResponse {
  savedAs: string;
  previewUrl: string;
  cloudinaryUrl?: string | null;
}

export interface CattleMatch {
  cattleId: string;
  cattleNumber: number | null;
  cattleLabel: string;
  searchScope?: 'farmer_cattle' | 'nearby_location' | 'outside_location' | 'all_other_muzzle';
  farmerId: string;
  farmerName: string;
  fieldOfficerName: string;
  locationLat: number | null;
  locationLon: number | null;
  rootFolderLocation: string;
  sessionCount: number;
  lastCaptureDate: string | null;
  lastStatus: string;
  distanceKm: number | null;
  withinRadius?: boolean;
}


export interface CattleImageSummary {
  imageType: string;
  fileName: string;
  previewUrl: string;
  cloudinaryUrl: string | null;
  url: string;
  localPath: string;
  uploadedAt: string | null;
  cloudinaryPublicId: string | null;
  cloudinaryError: string | null;
}

export interface CattleSessionSummary {
  sessionId: string;
  captureDate: string;
  captureDateTime: string;
  uploadDateTime: string;
  status: string;
  folderLocation: string;
  cloudinaryFolder: string | null;
  productionFolder: string;
  imageCount: number;
  previewUrl: string | null;
  cloudinaryUrl: string | null;
  matchResult: MuzzleMatchResolution | null;
  duplicateSavedSeparately?: boolean;
  duplicateOfCattleId?: string | null;
  duplicateOfFarmerName?: string;
  images: CattleImageSummary[];
}

export interface CattleSummary {
  cattleId: string;
  cattleNumber: number | null;
  cattleLabel: string;
  searchScope?: 'farmer_cattle' | 'nearby_location' | 'outside_location' | 'all_other_muzzle';
  farmerId: string;
  farmerName: string;
  fieldOfficerId: string;
  fieldOfficerName: string;
  workflow: 'cattle_enrolment' | 'cattle_search';
  locationLat: number | null;
  locationLon: number | null;
  status: string;
  isDuplicateEvidence?: boolean;
  duplicateOfCattleId?: string | null;
  duplicateOfFarmerName?: string;
  rootFolderLocation: string;
  cloudinaryRootFolder: string | null;
  productionFolder: string;
  sessionCount: number;
  imageCount: number;
  lastCaptureDate: string | null;
  lastCaptureDateTime: string | null;
  lastPreviewUrl: string | null;
  lastCloudinaryUrl: string | null;
  searchCount?: number;
  reviewedSearchCount?: number;
  pendingReviewCount?: number;
  lastSearchDate?: string | null;
  searchReviewState?: 'not_searched' | 'pending_review' | 'reviewed';
  sessions: CattleSessionSummary[];
}

export interface CattleStats {
  cattleCount: number;
  uniqueCattleCount?: number;
  duplicateCaptureCount?: number;
  cattleSearchCount?: number;
  blockedDuplicateEnrollmentCount?: number;
  duplicateImageCount?: number;
  totalRecordCount?: number;
  farmerCount: number;
  sessionCount: number;
  imageCount: number;
  repeatedCattleCount: number;
  farmers: Array<{
    farmerName: string;
    farmerId: string;
    cattleCount: number;
    sessionCount: number;
    imageCount: number;
  }>;
}
export interface FarmerMatch {
  key: string;
  farmerId: string;
  farmerName: string;
  cattleCount: number;
  visitCount: number;
  imageCount: number;
  distanceKm: number | null;
  withinRadius: boolean;
  lastCaptureDate: string | null;
}

export interface FarmerSyncResponse {
  farmers: Array<{
    key: string;
    farmerId: string;
    farmerName: string;
    locationLat: number | null;
    locationLon: number | null;
    cattleCount: number;
    visitCount: number;
    imageCount: number;
    lastCaptureDate: string | null;
    updatedAt: string;
  }>;
  farmerCount: number;
  generatedAt: string;
  datasetVersion: string;
}

export interface AppUser {
  userId: string;
  role: 'admin' | 'agent';
  name: string;
  phone: string;
  agentId: string;
  active: boolean;
  createdAt: string;
}

export interface YoloStatus {
  ok: boolean;
  modelPath: string;
  task?: string;
  opencvVersion?: string;
  error?: string;
}

export interface EmbeddingStatus {
  ok: boolean;
  modelPath: string;
  threshold: number;
  thresholdPercent?: number;
  embeddingDim?: number;
  hasConfig?: boolean;
  stateKeyCount?: number;
  torchVersion?: string;
  error?: string;
}

export interface PineconeStatus {
  ok: boolean;
  enabled: boolean;
  namespace?: string;
  indexHost?: string;
  dimension?: number;
  totalVectorCount?: number;
  error?: string;
}

export interface AppVersionStatus {
  appVersion: string;
  captureWorkflowVersion: string;
  tfliteMuzzleModelVersion: string;
  backendYoloModelVersion: string;
  dinov2ModelVersion: string;
  muzzleImageCount: number;
  thresholds: {
    muzzleConfidence: number;
    embeddingMatch: number;
    embeddingMatchPercent: number;
  };
  pineconeNamespaces: {
    enrolment: string;
    search: string;
  };
}

export interface MatchReviewImage {
  imageType: string;
  previewUrl: string;
  cloudinaryUrl: string | null;
}

export interface MatchReview {
  auditId: string;
  cattleId: string;
  finalCattleId: string;
  workflow?: 'cattle_enrolment' | 'cattle_search';
  sessionId: string;
  decision: 'matched_existing' | 'new_cattle';
  confidence: number;
  confidencePercent: number;
  thresholdPercent: number;
  appVersion?: string;
  captureWorkflowVersion?: string;
  tfliteMuzzleModelVersion?: string;
  backendYoloModelVersion?: string;
  dinov2ModelVersion?: string;
  captureDurationSeconds?: number | null;
  muzzleImageCount?: number;
  matchedCattleId: string | null;
  previousCattleId?: string | null;
  topMatches: MuzzleMatchResult[];
  rankedTopMatches?: MuzzleMatchResult[];
  farmerComparison?: FarmerMatchComparison | null;
  farmerId?: string;
  farmerName: string;
  fieldOfficerId?: string;
  fieldOfficerName: string;
  locationLat?: number | null;
  locationLon?: number | null;
  locationAccuracyM?: number | null;
  matchRadiusKm?: number;
  searchStrategy?: 'selected_farmer_then_location' | 'location_only';
  folderLocation: string;
  captureDate: string;
  resolvedAt: string;
  reviewStatus: string;
  correctCattleId: string | null;
  reviewNotes: string;
  images: MatchReviewImage[];
}

function normalizeApiBaseUrl(value: unknown): string {
  const url = String(value || '/api').replace(/\/+$/, '');
  return /\/api$/i.test(url) ? url : `${url}/api`;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly runtimeConfig = (window as any).VACAPAY_CONFIG || {};
  private readonly baseUrl = normalizeApiBaseUrl(this.runtimeConfig.apiBaseUrl);
  private readonly mediaBaseUrl = String(this.runtimeConfig.mediaBaseUrl || this.baseUrl.replace(/\/api$/, '')).replace(/\/$/, '');
  private token = localStorage.getItem('vacapay_token') || '';

  constructor(private readonly http: HttpClient) { }

  login(identifier: string, password: string): Observable<{ token: string; user: AppUser }> {
    return this.http.post<{ token: string; user: AppUser }>(`${this.baseUrl}/auth/login`, { identifier, password });
  }

  embeddingStatus(): Observable<EmbeddingStatus> {
    return this.http.get<EmbeddingStatus>(`${this.baseUrl}/embedding/status`, { headers: this.authHeaders() });
  }

  pineconeStatus(): Observable<PineconeStatus> {
    return this.http.get<PineconeStatus>(`${this.baseUrl}/pinecone/status`, { headers: this.authHeaders() });
  }

  appVersion(): Observable<AppVersionStatus> {
    return this.http.get<AppVersionStatus>(`${this.baseUrl}/version`);
  }

  setToken(token: string): void {
    this.token = token;
    localStorage.setItem('vacapay_token', token);
  }

  clearToken(): void {
    this.token = '';
    localStorage.removeItem('vacapay_token');
  }

  listAgents(): Observable<{ agents: AppUser[] }> {
    return this.http.get<{ agents: AppUser[] }>(`${this.baseUrl}/agents`, { headers: this.authHeaders() });
  }

  listCattle(): Observable<{ stats: CattleStats; cattle: CattleSummary[] }> {
    return this.http.get<{ stats: CattleStats; cattle: CattleSummary[] }>(`${this.baseUrl}/cattle`, { headers: this.authHeaders() });
  }

  downloadCattleZip(cattleIds: string[]): Observable<Blob> {
    return this.http.post(`${this.baseUrl}/cattle/download`, { cattleIds }, {
      headers: this.authHeaders(),
      responseType: 'blob'
    });
  }

  mergeCattleRecords(targetCattleId: string, sourceCattleIds: string[]): Observable<{ target: CattleSummary; mergedCattleIds: string[] }> {
    return this.http.post<{ target: CattleSummary; mergedCattleIds: string[] }>(`${this.baseUrl}/cattle/merge`, { targetCattleId, sourceCattleIds }, { headers: this.authHeaders() });
  }

  approveBlockedCattle(cattleId: string, reviewNotes?: string): Observable<{ cattle: CattleSummary; message: string }> {
    return this.http.post<{ cattle: CattleSummary; message: string }>(
      `${this.baseUrl}/cattle/${cattleId}/approve-blocked`,
      { reviewNotes: reviewNotes || 'Admin confirmed this is a different cow.' },
      { headers: this.authHeaders() }
    );
  }

  listMatchReviews(uncertainOnly = true): Observable<{ reviews: MatchReview[] }> {
    return this.http.get<{ reviews: MatchReview[] }>(`${this.baseUrl}/reviews/matches?uncertainOnly=${uncertainOnly}`, { headers: this.authHeaders() });
  }


  updateMatchReview(auditId: string, payload: { reviewStatus: string; correctCattleId?: string; reviewNotes?: string; action?: 'move_out_as_registered' }): Observable<{ review: MatchReview; correctedRecord?: CattleSummary | null }> {
    return this.http.post<{ review: MatchReview }>(`${this.baseUrl}/reviews/matches/${auditId}`, payload, { headers: this.authHeaders() });
  }

  createAgent(payload: { name: string; phone: string; agentId: string; password: string }): Observable<{ agent: AppUser }> {
    return this.http.post<{ agent: AppUser }>(`${this.baseUrl}/agents`, payload, { headers: this.authHeaders() });
  }

  createEnrollment(payload: Partial<Enrollment> & { matchRadiusKm?: number; newFarmer?: boolean; workflow?: 'cattle_enrolment' | 'cattle_search'; offlineCaptureId?: string }): Observable<{ enrollment: Enrollment }> {
    return this.http.post<{ enrollment: Enrollment }>(`${this.baseUrl}/enrollments`, payload, { headers: this.authHeaders() });
  }

  searchFarmers(params: {
    q?: string;
    lat?: number | null;
    lon?: number | null;
    radiusKm?: number;
  }): Observable<{ farmers: FarmerMatch[] }> {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.lat !== null && params.lat !== undefined) query.set('lat', String(params.lat));
    if (params.lon !== null && params.lon !== undefined) query.set('lon', String(params.lon));
    if (params.radiusKm) query.set('radiusKm', String(params.radiusKm));
    return this.http.get<{ farmers: FarmerMatch[] }>(`${this.baseUrl}/farmers?${query.toString()}`, { headers: this.authHeaders() });
  }

  downloadFarmerData(): Observable<FarmerSyncResponse> {
    return this.http.get<FarmerSyncResponse>(`${this.baseUrl}/farmers/sync`, { headers: this.authHeaders() });
  }
  searchRegisteredCattle(params: {
    farmerId?: string;
    farmerName?: string;
    lat?: number | null;
    lon?: number | null;
    radiusKm?: number;
  }): Observable<{ cattle: CattleMatch[] }> {
    const query = new URLSearchParams();
    if (params.farmerId) query.set('farmerId', params.farmerId);
    if (params.farmerName) query.set('farmerName', params.farmerName);
    if (params.lat !== null && params.lat !== undefined) query.set('lat', String(params.lat));
    if (params.lon !== null && params.lon !== undefined) query.set('lon', String(params.lon));
    if (params.radiusKm) query.set('radiusKm', String(params.radiusKm));
    return this.http.get<{ cattle: CattleMatch[] }>(`${this.baseUrl}/cattle/search?${query.toString()}`, { headers: this.authHeaders() });
  }

  checkMuzzleFrame(file: Blob): Observable<MuzzleGateResponse> {
    const formData = new FormData();
    formData.append('image', file, 'muzzle-frame.jpg');
    return this.http.post<MuzzleGateResponse>(`${this.baseUrl}/muzzle/check`, formData, { headers: this.authHeaders() });
  }

  captureMuzzle(cattleId: string, file: Blob, slot: number, clientProcessed = false): Observable<MuzzleCaptureResponse> {
    const formData = new FormData();
    formData.append('image', file, `muzzle${slot}.jpg`);
    formData.append('slot', String(slot));
    if (clientProcessed) formData.append('clientProcessed', 'true');
    return this.http.post<MuzzleCaptureResponse>(`${this.baseUrl}/enrollments/${cattleId}/muzzle`, formData, { headers: this.authHeaders() });
  }

  saveImage(cattleId: string, type: string, file: File | Blob): Observable<ManualImageResponse> {
    const formData = new FormData();
    formData.append('image', file, `${type}.jpg`);
    formData.append('type', type);
    return this.http.post<ManualImageResponse>(`${this.baseUrl}/enrollments/${cattleId}/images`, formData, { headers: this.authHeaders() });
  }

  complete(cattleId: string, durationSeconds?: number): Observable<{ enrollment: Enrollment }> {
    return this.http.post<{ enrollment: Enrollment }>(`${this.baseUrl}/enrollments/${cattleId}/complete`, { captureDurationSeconds: durationSeconds }, { headers: this.authHeaders() });
  }

  resolveMuzzleMatch(cattleId: string): Observable<{ matchResolution: MuzzleMatchResolution }> {
    return this.http.post<{ matchResolution: MuzzleMatchResolution }>(`${this.baseUrl}/enrollments/${cattleId}/resolve-muzzle-match`, {}, { headers: this.authHeaders() });
  }

  mediaUrl(path: string): string {
    return `${this.mediaBaseUrl}${path}`;
  }

  private authHeaders(): HttpHeaders {
    return this.token ? new HttpHeaders({ Authorization: `Bearer ${this.token}` }) : new HttpHeaders();
  }
}
