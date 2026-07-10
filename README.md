# Vacapay Muzzle Field Testing App

Vacapay Muzzle is a field-testing app for cattle muzzle identification.

The app has two official workflows:

```text
Cattle Enrolment
Cattle Search
```

Use cattle enrolment to create clean registered cattle identities. Use cattle search to test whether a captured cow is already registered or should return no cattle found.

## Quick Links

- Full workflow: [docs/FIELD_APP_FULL_WORKFLOW.md](docs/FIELD_APP_FULL_WORKFLOW.md)
- Backend: [backend/src/server.js](backend/src/server.js)
- Agent/Admin UI: [frontend/src/app/app.component.html](frontend/src/app/app.component.html)
- Phone TFLite muzzle check: [frontend/src/app/tflite-muzzle-detector.service.ts](frontend/src/app/tflite-muzzle-detector.service.ts)
- Offline storage: [frontend/src/app/offline-storage.service.ts](frontend/src/app/offline-storage.service.ts)
- Offline sync: [frontend/src/app/sync.service.ts](frontend/src/app/sync.service.ts)

## Production Hardening Added

The current build includes these verified hardening changes:

```text
JWT login for admin and field agents
protected farmer, cattle, enrolment, capture, review and download APIs
offline browser capture storage using IndexedDB
automatic sync retry when the phone comes back online
PWA manifest and service worker asset caching
GPS caching for repeated captures in the same location
low battery warning where the browser Battery API is available
vibration and short beep feedback after capture
capture duration saved when a record is completed
offline sync preserves capture duration when records upload later
service worker cache version is bumped to vacapay-v2 for fresh field builds
/api/version exposes app, model, threshold and Pinecone namespace details
admin filters and CSV export for match review
CSV export includes capture duration and model/build versions
side-by-side admin review of search images and matched registered cattle images
mobile cattle search action is fixed above the bottom nav after farmer selection
offline sync uses stable cattle IDs and resumes the same capture instead of creating duplicate cattle records
offline sync preserves the selected GPS radius
stuck syncing records are recovered back to pending on app start
cattle enrolment duplicate matches are blocked/warned separately and are not counted as cattle search metrics
admin field-test metrics count only workflow=cattle_search records
admin review API returns up to 5000 records for field-test batches
CSV export uses Blob download to avoid broken exports with special characters
```

Production note:

```text
The browser app now has a phone-side TFLite muzzle gate.
The final native Android app should keep the same flow but run the model from Android assets.
The current browser PWA still loads TensorFlow JS/TFLite loader scripts from CDN before it can run the local best.tflite model, so true first-use offline Android production still requires bundling that runtime in the native app.
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
search farmer by GPS or name
select farmer context
capture cow images
app returns Cattle Found or No Cattle Found
save search record for admin review
```

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

## Phone Muzzle Gate And Blur Check

The browser field app uses:

```text
frontend/src/assets/models/best.tflite
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
1. selected farmer cattle
2. all registered cattle
```

Search source tags:

```text
farmer_cattle
all_other_muzzle
```

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
-> YOLO TFLite muzzle detection
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

