# Vacapay Muzzle — Change Report
**Period:** 18 July 2026  
**Prepared by:** Kiro AI  
**Project:** `vacapay_muzzle--main`

---

## Session 1 — Codebase Understanding & Analysis

### What was done
A full deep-dive into the codebase was performed to understand how the muzzle capture system works end-to-end. No code changes were made in this session — it was pure analysis.

### Files read and analysed
| File | Purpose |
|------|---------|
| `backend/src/server.js` | Express API server — enrollments, muzzle upload, embedding, Pinecone matching |
| `frontend/src/app/tflite-muzzle-detector.service.ts` | On-device YOLO TFLite muzzle detection service |
| `frontend/src/app/app.component.ts` | Main Angular component — all agent/admin UI logic |
| `frontend/src/app/api.service.ts` | HTTP client service — all API calls |
| `frontend/src/app/app.component.html` | Full UI template |

### Summary of findings (documented for the team)

**End-to-end muzzle capture pipeline:**

1. **On-device detection** (`tflite-muzzle-detector.service.ts`)
   - A YOLO TFLite model (`best.tflite`) runs directly in the browser
   - Each video frame is letterboxed to 640×640 and fed to the model
   - The model classifies two classes: `goodmuzzle` and `bad muzzle`
   - Frames are auto-rejected if: no box found, class is bad muzzle, confidence < 50%, or sharpness score < 18
   - Accepted crops are enhanced with CLAHE (Contrast Limited Adaptive Histogram Equalization) in a 4×4 tile grid before saving

2. **Server-side matching** (`backend/src/server.js`)
   - Uploaded muzzle images are processed by a DINOv2 model (`dinov2_triplet_v2_best.pt`) via Python subprocess
   - Each image produces a 768-dimensional embedding vector
   - After 3 images are collected, embeddings are averaged for a robust identity
   - The averaged vector is searched against Pinecone (vector database)
   - Search is scoped: selected farmer first → nearby GPS radius → all other cattle
   - A cosine similarity threshold of 0.70 determines `matched_existing` vs `new_cattle`

---

## Session 2 — UI Changes: Field Officer App

### Change 1 — Hide the manual muzzle capture fallback button

**File changed:** `frontend/src/app/app.component.html`

**Problem:**  
After 15 seconds of auto-scanning, a "Taking too long? Capture Now" button appeared in the muzzle screen. This allowed the agent to manually capture any frame regardless of muzzle quality, bypassing the YOLO quality gate entirely.

**What was changed:**  
The entire `cm-manual-capture` block was removed from the muzzle screen.

```html
<!-- REMOVED — was showing after 15s of scanning -->
<div class="cm-manual-capture"
  *ngIf="autoCaptureOn && muzzleScanSeconds >= 15 && muzzlePreviews.length < muzzleImageCount">
  <div class="cm-manual-info">
    <strong>Taking too long?</strong>
    <span>Tap the button to capture the current frame manually, then continue scanning.</span>
  </div>
  <button type="button" class="cm-manual-btn" (click)="manualCaptureMuzzle()">
    Capture Now
  </button>
</div>
```

**After the change:**  
Replaced with a single comment line. Auto-scan is now the only capture method — every muzzle photo must pass the quality gate (YOLO confidence + sharpness).

**Impact:**  
- Ensures all enrolled muzzle images meet minimum quality standards
- Prevents low-quality captures that would degrade AI matching accuracy
- No logic changes in TypeScript — purely a template change

---

### Change 2 — Context-aware upload overlay text for Cattle Search

**File changed:** `frontend/src/app/app.component.html`

**Problem:**  
The upload/processing overlay (spinner screen shown while photos are being saved and matched) always displayed "Registering cattle" as its heading — even when the agent was performing a **Cattle Search** (not enrolment). This confused field officers because they were not registering a new cow, they were searching for an existing one.

**What was changed:**  
The hardcoded heading in the upload overlay was made dynamic based on `captureWorkflow`.

```html
<!-- BEFORE -->
<h2>Registering cattle</h2>

<!-- AFTER -->
<h2>{{ captureWorkflow === 'cattle_search' ? 'Searching cattle' : 'Registering cattle' }}</h2>
```

**After the change:**  
| Workflow | Overlay heading |
|----------|----------------|
| `cattle_enrolment` | Registering cattle |
| `cattle_search` | Searching cattle |

**Impact:**  
- Clearer UX — field officers understand what the app is doing during upload
- No logic or backend changes — purely a display fix

---

## Session 3 — Login Page Layout Fix

### Change 3 — Always show full login layout with Agent/Admin toggle

**File changed:** `frontend/src/app/app.component.ts`

**Problem:**  
The app had a flag `isNativeFieldApp` that determined whether to show the full login experience (brand visual panel, phone mockup, Agent/Admin segmented toggle) or the stripped-down admin-only card. The flag was computed as:

```typescript
// BEFORE
readonly isNativeFieldApp = Boolean(
  (window as any).Capacitor?.isNativePlatform?.() ||
  !window.location.hostname.includes('localhost')
);
```

On `localhost` (desktop browser), this evaluated to `false`, so:
- The visual brand panel was hidden
- The Agent/Admin toggle was hidden
- Only the plain admin sign-in card was shown
- Agent accounts were actively blocked from logging in with the error: *"Use the Vacapay Field Android app for field officer access"*

**Three code changes were made:**

#### 3a — `isNativeFieldApp` always true

```typescript
// BEFORE
readonly isNativeFieldApp = Boolean(
  (window as any).Capacitor?.isNativePlatform?.() ||
  !window.location.hostname.includes('localhost')
);

// AFTER
readonly isNativeFieldApp = true;
```

#### 3b — Removed constructor guard that evicted saved agent sessions

```typescript
// REMOVED from constructor
if (this.currentUser.role === 'agent' && !this.isNativeFieldApp) {
  this.api.clearToken();
  localStorage.removeItem('vacapay_user');
  this.currentUser = undefined;
  this.message = 'Field officer access is available in the Android app. This website is for administrators.';
  return;
}
```

This block was running on every page reload for saved agent sessions, logging them out immediately.

#### 3c — Removed login-time agent rejection

```typescript
// REMOVED from login() method
if (user.role === 'agent' && !this.isNativeFieldApp) {
  this.api.clearToken();
  localStorage.removeItem('vacapay_user');
  this.currentUser = undefined;
  this.loginPassword = '';
  this.message = 'Use the Vacapay Field Android app for field officer access.';
  return;
}
```

**After the change:**  
- Full two-column login layout visible everywhere (localhost, production, any browser)
- Agent/Admin segmented toggle always visible
- Brand visual panel with phone mockup always visible
- Agent accounts can sign in from any browser — no platform restriction
- Admin accounts continue to work exactly as before

**Impact:**  
- Consistent UI across all environments
- Field officers can test and use the app from a desktop browser without needing the Android APK
- No backend changes — the server's role-based auth still controls what each user can access after login

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `frontend/src/app/app.component.html` | 1. Removed manual muzzle capture block · 2. Dynamic upload overlay heading |
| `frontend/src/app/app.component.ts` | 3. `isNativeFieldApp` always true · 4. Removed constructor agent guard · 5. Removed login agent rejection |

## Build Status
All changes compiled successfully with `ng build --configuration production`.  
Only a bundle size budget warning exists (pre-existing, unrelated to these changes).

---

*End of report*
