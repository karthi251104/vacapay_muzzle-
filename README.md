# Vacapay Muzzle Field Testing App

Vacapay Muzzle is a field-testing app for cattle muzzle identification.

## Start Here

For a new developer or a newly cloned computer, follow the complete setup and
handoff guide first:

- [Complete Windows setup, local run, Cloudflare, APK and Git push](docs/COLLEAGUE_SETUP.md)
- [Full field workflow](docs/FIELD_APP_FULL_WORKFLOW.md)
- [App architecture, diagrams, model scores and metrics](docs/APP_ARCHITECTURE_AND_METRICS.md)
- [Codex account handoff and model-security status](docs/CODEX_HANDOFF.md)
- [Production deployment](docs/PRODUCTION_DEPLOYMENT.md)

The setup guide includes Git LFS model download, Node/pnpm/Python installation,
private `.env` configuration, Android Studio SDK setup, APK generation,
Cloudflare phone testing, verification, troubleshooting and safe Git commands.

## Production Surfaces

- **Admin website:** administrator accounts only. It provides enrolment inventory, cattle-search metrics, query evidence, Top-5 visual cattle comparisons, the full Top-20 ranking, and review decisions.
- **Android field app:** field officer capture and offline upload. Browser sessions reject field officer accounts; the field workflow is enabled only inside the Capacitor Android application.
- **Backend:** Express, MongoDB Atlas, Cloudinary, backend YOLO `best.pt`, DINOv2 and Pinecone run locally, through Docker, or on a Linux host with sufficient memory. A local PC can be exposed temporarily with Cloudflare Tunnel for controlled field testing. See [Production Deployment](docs/PRODUCTION_DEPLOYMENT.md).
- **Netlify admin hosting:** `netlify.toml` builds only the lightweight admin target and injects the backend API URL from `VACAPAY_API_BASE_URL`.

The admin review expands each cattle search into query muzzle and side images, Top-5 candidate cattle with enrolled muzzle and body evidence, and Top-20 ranked identities. Selecting a candidate records the expected cattle identity for field accuracy metrics.

The app has two official workflows:

```text
Cattle Enrolment
Cattle Search
```

Use cattle enrolment to create clean registered cattle identities. Use cattle search to test whether a captured cow is already registered or should return no cattle found.

## Quick Links

- Complete developer setup: [docs/COLLEAGUE_SETUP.md](docs/COLLEAGUE_SETUP.md)
- Full workflow: [docs/FIELD_APP_FULL_WORKFLOW.md](docs/FIELD_APP_FULL_WORKFLOW.md)
- Architecture and metrics: [docs/APP_ARCHITECTURE_AND_METRICS.md](docs/APP_ARCHITECTURE_AND_METRICS.md)
- Codex continuation handoff: [docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md)
- Backend: [backend/src/server.js](backend/src/server.js)
- Agent/Admin UI: [frontend/src/app/app.component.html](frontend/src/app/app.component.html)
- Backend YOLO PT muzzle check: [backend/scripts/yolo_pt_muzzle_check.py](backend/scripts/yolo_pt_muzzle_check.py)
- Phone TFLite offline fallback: [frontend/src/app/tflite-muzzle-detector.service.ts](frontend/src/app/tflite-muzzle-detector.service.ts)
- Offline storage: [frontend/src/app/offline-storage.service.ts](frontend/src/app/offline-storage.service.ts)
- Offline sync: [frontend/src/app/sync.service.ts](frontend/src/app/sync.service.ts)

## Production Hardening Added

The current build includes these verified hardening changes:

```text
JWT login for admin and field agents
protected farmer, cattle, enrolment, capture, review and download APIs
offline browser capture storage using IndexedDB
completed records remain on the phone until a successful upload; online completion starts upload automatically and failed uploads remain retryable
incomplete drafts are excluded from upload
PWA manifest and service worker asset caching
fresh GPS capture is mandatory for every Cattle Search
offline farmer directory has an isolated IndexedDB store and cannot erase pending captures
farmer name/ID and nearby-GPS lookup work from downloaded phone data
low battery warning where the browser Battery API is available
vibration and short beep feedback after capture
capture duration saved when a record is completed
offline sync preserves capture duration when records upload later
service worker cache is versioned for fresh field builds
/api/version exposes app, model, threshold and Pinecone namespace details
admin filters and CSV export for match review
CSV export includes capture duration and model/build versions
side-by-side admin review of search images and matched registered cattle images
mobile Cattle Search can start with GPS alone; farmer selection is optional
offline sync uses stable cattle IDs and resumes the same capture instead of creating duplicate cattle records
offline sync preserves the selected GPS radius
stuck syncing records are recovered back to pending on app start
cattle enrolment duplicate matches are blocked/warned separately and are not counted as cattle search metrics
admin field-test metrics count only workflow=cattle_search records
admin review API returns up to 5000 records for field-test batches
CSV export uses Blob download to avoid broken exports with special characters
```

## Fresh Field-Test Reset

Run this only when starting a new test cycle:

```powershell
pnpm --dir backend run reset:field-data
```

It preserves admin and field-officer accounts while clearing cattle enrolments, cattle searches, review decisions, local capture folders, both Pinecone namespaces, and Cloudinary cattle images. A fresh field APK uses a new IndexedDB queue so captures from an older test build cannot upload into the new cycle.

Production note:

```text
The app has a hybrid muzzle gate. When online, it tries the backend YOLO PyTorch model at `backend/best.pt`. If the backend is unavailable or the phone is offline, it falls back to the phone-side TFLite model at `frontend/src/assets/models/best.tflite`. The field build bundles the pinned TensorFlow JS/TFLite runtime, WASM files and phone model inside the APK; it does not require a CDN for offline checking.
```

## Agent Flow

The agent home screen has three choices.

### 1. Add Farmer + Enrol Cow

Use this for a new farmer.

```text
enter farmer name
use GPS
app creates unique farmer ID
capture cow images
save as registered cattle
```

### 2. Add Cow To Farmer

Use this when the farmer already exists but the cow is new.

```text
search farmer by GPS or name
select farmer
capture cow images
save as registered cattle under selected farmer
```

### 3. Cattle Search

Use this when checking a cow against existing registered cattle.

```text
app captures fresh GPS (required)
optionally search/select a downloaded farmer by name or ID
capture cow images
if farmer selected: check that farmer's cattle first
if no farmer match, or no farmer selected: check cattle near GPS
app returns Cattle Found or No Cattle Found
save search record for admin review
```

Before field work, tap **Update Farmer Data** while online. The phone downloads farmer ID, name, location and cattle counts into a separate local farmer store. Name/ID and nearby-farmer lookup then work without internet. Updating this directory never clears pending enrolments or cattle searches.

Important:

```text
For the same cow again, use Cattle Search.
Do not enrol the same cow again.
```

## Capture Requirements

Current field-testing capture count:

```text
3 muzzle images
7 supporting images
```

Supporting images:

```text
face1
face2
face3
leftside
rightside
back
udder
```

The muzzle images are used for embeddings. Supporting images are used by admin to verify whether the app result is correct.
All seven supporting views are required. The capture screen does not allow a view to be skipped because an incomplete record cannot be evaluated reliably.

## Phone Muzzle Gate And Blur Check

The field app uses a hybrid muzzle gate:

```text
online backend path: backend/best.pt
offline phone fallback: frontend/src/assets/models/best.tflite
```

Classes:

```text
goodmuzzle
bad muzzle
```

Current capture thresholds:

```text
minimum good muzzle confidence: 0.50
minimum bad muzzle confidence: 0.45
bad dominance margin: 0.12
minimum blur/sharpness score: 18
```

Only good, sharp muzzle crops are uploaded. Blurry images are rejected before they can affect the DINOv2 embedding average.

The phone fallback currently accepts `goodmuzzle` at 0.50. The backend PT gate uses `MUZZLE_CONF` (0.55 in `.env.example`). Admin audit rows store the phone TFLite and backend YOLO model versions separately.

The accepted crop also receives local contrast enhancement before upload.

## Offline Capture And Sync

If the phone loses internet during field work:

```text
new capture is saved in IndexedDB
muzzle crops are stored locally
supporting images are stored locally
pending count appears in the UI
sync retries when the browser goes online again
failed sync records are kept for retry
```

Important:

```text
Offline capture is a browser/PWA safety layer.
For final production Android, the same records should be saved in native local storage and uploaded from a dedicated upload screen.
```

## Embedding And Search

For each accepted muzzle crop:

```text
muzzle1 -> DINOv2 embedding 1
muzzle2 -> DINOv2 embedding 2
muzzle3 -> DINOv2 embedding 3
```

Backend averages the three embeddings:

```text
average embedding = mean(embedding1, embedding2, embedding3)
```

Cattle search compares the average search embedding against registered cattle embeddings.

Search order:

```text
1. selected farmer cattle (only when a farmer was selected)
2. registered cattle within the configured GPS radius
```

Search source tags:

```text
farmer_cattle
nearby_location
```

`all_other_muzzle` remains only as a legacy/admin label for older records. New cattle searches do not automatically accept cattle outside the configured location radius.

## Pinecone Separation

The app keeps registered cattle and search evidence separate.

```text
vacapay-cattle-enrolment
vacapay-cattle-search
```

`vacapay-cattle-enrolment` stores clean registered cattle identities and is used as the search gallery.

`vacapay-cattle-search` stores field search evidence and is not used as the main registered cattle gallery.

## Admin Review

Admin dashboard focuses on the field-testing result:

```text
Total cattle enrolled
Total cattle searches
Cattle found correct
Cattle found incorrect
No cattle found correct
No cattle found incorrect
Pending review
Top-1 accuracy
Top-5 accuracy
```

The dashboard also compares the normal overall field-search ranking with a selected-farmer-only
ranking. Both come from the same Cattle Search and the same three-muzzle average embedding. Admin
sets ground truth once; each strategy receives separate Top-1, Top-5, and found/not-found metrics.
Searches without selected farmer cattle are N/A for the farmer-only metric, and the operational
70% matching decision is unchanged.

The **Enrollment Search Coverage** section tracks field progress separately from model accuracy:

```text
Total cows enrolled
Unique enrolled cows searched
Enrolled cows not yet searched
Search coverage percentage
Officer-wise enrolled/searched/not-searched totals
Cow-by-cow searched/not-searched status and search count
```

The officer and status filters make it possible to check each officer's enrolment target and see exactly which enrolled cows still need a Cattle Search. A matched cow counts provisionally; after admin review, the admin-confirmed cattle identity is used. A correctly reviewed new-cow result does not count as an enrolled cow being searched.

Admin review actions:

```text
Correct - Cattle Found
Incorrect - Cattle Found
Correct - No Cattle Found
Incorrect - Cattle Exists
Register As New Cow
```

This matches the field test requirement: every cattle search result is checked later as correct or incorrect.

## Production Android Direction

Production Android should run capture processing offline on the phone:

```text
camera frame
-> YOLO/TFLite muzzle detection on phone when offline
-> good/bad muzzle quality check
-> crop
-> CLAHE/local enhancement
-> save good crops locally
-> upload later when internet is good
-> backend creates embeddings and Pinecone vectors
```

The backend should not be required for real-time field capture in low-internet areas.

## Field Test Target

Suggested field test plan:

```text
50 cattle enrolments per officer
50 cattle searches per officer
```

Cattle searches should include:

```text
already enrolled cows where correct result is Cattle Found
new cows where correct result is No Cattle Found
```

