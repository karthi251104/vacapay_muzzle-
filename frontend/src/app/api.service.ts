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
  rootFolderLocation: string;
  folderLocation: string;
  captureDateTime: string;
  uploadDateTime: string;
  status: string;
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

export interface MuzzleCaptureResponse {
  slot: number;
  savedAs: string;
  previewUrl: string;
  cloudinaryUrl?: string | null;
  matchResolution?: MuzzleMatchResolution | null;
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
  searchScope?: 'farmer_cattle' | 'all_other_muzzle';
  sessionId: string;
  farmerName: string;
  fieldOfficerName: string;
  locationLat: number | null;
  locationLon: number | null;
  distanceKm: number | null;
  score: number;
  confidencePercent: number;
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
  searchScope?: 'farmer_cattle' | 'all_other_muzzle';
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
  searchScope?: 'farmer_cattle' | 'all_other_muzzle';
  farmerId: string;
  farmerName: string;
  fieldOfficerId: string;
  fieldOfficerName: string;
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
  sessions: CattleSessionSummary[];
}

export interface CattleStats {
  cattleCount: number;
  uniqueCattleCount?: number;
  duplicateCaptureCount?: number;
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

export interface MatchReviewImage {
  imageType: string;
  previewUrl: string;
  cloudinaryUrl: string | null;
}

export interface MatchReview {
  auditId: string;
  cattleId: string;
  finalCattleId: string;
  sessionId: string;
  decision: 'matched_existing' | 'new_cattle';
  confidence: number;
  confidencePercent: number;
  thresholdPercent: number;
  matchedCattleId: string | null;
  previousCattleId?: string | null;
  topMatches: MuzzleMatchResult[];
  farmerName: string;
  fieldOfficerName: string;
  folderLocation: string;
  captureDate: string;
  resolvedAt: string;
  reviewStatus: string;
  correctCattleId: string | null;
  reviewNotes: string;
  images: MatchReviewImage[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly baseUrl = '/api';
  private readonly mediaBaseUrl = '';
  private token = localStorage.getItem('vacapay_token') || '';

  constructor(private readonly http: HttpClient) {}

  login(identifier: string, password: string): Observable<{ token: string; user: AppUser }> {
    return this.http.post<{ token: string; user: AppUser }>(`${this.baseUrl}/auth/login`, { identifier, password });
  }

  yoloStatus(): Observable<YoloStatus> {
    return this.http.get<YoloStatus>(`${this.baseUrl}/yolo/status`);
  }

  embeddingStatus(): Observable<EmbeddingStatus> {
    return this.http.get<EmbeddingStatus>(`${this.baseUrl}/embedding/status`);
  }

  pineconeStatus(): Observable<PineconeStatus> {
    return this.http.get<PineconeStatus>(`${this.baseUrl}/pinecone/status`);
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

  listMatchReviews(uncertainOnly = true): Observable<{ reviews: MatchReview[] }> {
    return this.http.get<{ reviews: MatchReview[] }>(`${this.baseUrl}/reviews/matches?uncertainOnly=${uncertainOnly}`, { headers: this.authHeaders() });
  }


  updateMatchReview(auditId: string, payload: { reviewStatus: string; correctCattleId?: string; reviewNotes?: string; action?: 'move_out_as_registered' }): Observable<{ review: MatchReview; correctedRecord?: CattleSummary | null }> {
    return this.http.post<{ review: MatchReview }>(`${this.baseUrl}/reviews/matches/${auditId}`, payload, { headers: this.authHeaders() });
  }

  createAgent(payload: { name: string; phone: string; agentId: string; password: string }): Observable<{ agent: AppUser }> {
    return this.http.post<{ agent: AppUser }>(`${this.baseUrl}/agents`, payload, { headers: this.authHeaders() });
  }

  createEnrollment(payload: Partial<Enrollment> & { matchRadiusKm?: number }): Observable<{ enrollment: Enrollment }> {
    return this.http.post<{ enrollment: Enrollment }>(`${this.baseUrl}/enrollments`, payload);
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
    return this.http.get<{ farmers: FarmerMatch[] }>(`${this.baseUrl}/farmers?${query.toString()}`);
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
    return this.http.get<{ cattle: CattleMatch[] }>(`${this.baseUrl}/cattle/search?${query.toString()}`);
  }

  captureMuzzle(cattleId: string, file: Blob, slot: number): Observable<MuzzleCaptureResponse> {
    const formData = new FormData();
    formData.append('image', file, `muzzle${slot}.jpg`);
    formData.append('slot', String(slot));
    return this.http.post<MuzzleCaptureResponse>(`${this.baseUrl}/enrollments/${cattleId}/muzzle`, formData);
  }

  saveImage(cattleId: string, type: string, file: File | Blob): Observable<ManualImageResponse> {
    const formData = new FormData();
    formData.append('image', file, `${type}.jpg`);
    formData.append('type', type);
    return this.http.post<ManualImageResponse>(`${this.baseUrl}/enrollments/${cattleId}/images`, formData);
  }

  complete(cattleId: string): Observable<{ enrollment: Enrollment }> {
    return this.http.post<{ enrollment: Enrollment }>(`${this.baseUrl}/enrollments/${cattleId}/complete`, {});
  }

  resolveMuzzleMatch(cattleId: string): Observable<{ matchResolution: MuzzleMatchResolution }> {
    return this.http.post<{ matchResolution: MuzzleMatchResolution }>(`${this.baseUrl}/enrollments/${cattleId}/resolve-muzzle-match`, {});
  }

  mediaUrl(path: string): string {
    return `${this.mediaBaseUrl}${path}`;
  }

  private authHeaders(): HttpHeaders {
    return this.token ? new HttpHeaders({ Authorization: `Bearer ${this.token}` }) : new HttpHeaders();
  }
}
