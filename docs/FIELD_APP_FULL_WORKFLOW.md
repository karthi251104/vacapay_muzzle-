# Vacapay Muzzle Field App Full Workflow

This document explains the current field-testing app from agent capture to backend embeddings, Pinecone search, and admin review.

The app has two official workflows:

```text
Cattle Enrolment
Cattle Search
```

Do not use old visit-based wording as the workflow name. A cattle search can find an existing cow, or it can correctly return no cattle found.

## 1. Main Idea

The project is for real field testing of cattle muzzle identification.

The field team first creates a clean registered cattle database through cattle enrolment. After that, they run cattle search tests to check whether the app can find an already registered cow or correctly say no cattle found for a new cow.

Admin reviews every cattle search result later and marks whether the app result was correct or incorrect.

## 2. Agent Home Screen

The agent starts from three clear choices.

All agent and admin API calls are protected after login. The frontend stores the login token and sends it with farmer search, cattle search, enrolment, image upload, completion, review and download requests.

### Add Farmer + Enrol Cow

Use this when the farmer is new.

What happens:

```text
agent enters farmer name
agent captures GPS
app generates a unique farmer ID
agent captures the first cow
backend saves this cow as registered cattle
registered cattle is used for future search
```

### Add Cow To Farmer

Use this when the farmer already exists and the agent wants to register another new cow under that farmer.

What happens:

```text
agent searches farmer by GPS or name
agent selects the registered farmer
agent captures the new cow
backend saves this cow as registered cattle under the selected farmer
registered cattle count increases
```

### Cattle Search

Use this when testing whether a cow is already registered.

What happens:

```text
agent searches farmer by GPS or name
agent selects farmer context
agent captures the cow muzzle
backend checks registered cattle
result is Cattle Found or No Cattle Found
search record is saved for admin review
registered cattle count does not increase
```

Important:

```text
If the same cow is being checked again, use Cattle Search.
Do not use Cattle Enrolment for the same cow again.
```

## 3. Farmer ID

Farmer IDs are unique and non-incremental.

Example:

```text
FARM-A7K9Q2M4
FARM-P4T8X6JD
FARM-W29LQ7RA
```

This avoids confusion when multiple agents work at the same time. The frontend can show a generated ID, but the backend makes the final saved farmer ID decision.

## 4. GPS And Farmer Search

Existing farmers can be found in two ways.

### GPS Search

The agent taps Use GPS and searches nearby farmers.

The result list shows:

```text
farmer name
farmer ID
distance
number of saved cows
number of captures
```

### Name Or ID Search

The agent types farmer name or farmer ID.

The result list shows matching registered farmers even when GPS is not enough.

After selecting a farmer, the app loads saved cow records under that farmer.

## 5. Image Capture Requirements

For faster field testing, the app currently uses:

```text
3 muzzle images
7 supporting images
```

Muzzle images:

```text
muzzle1
muzzle2
muzzle3
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

The 3 muzzle images are used for embeddings and matching.

The 7 supporting images are for admin human verification when checking whether the app result was correct.

## 6. Phone Muzzle Gate And Quality Check

The current browser field app loads the TFLite model from:

```text
frontend/src/assets/models/best.tflite
```

The model predicts two detection classes:

```text
goodmuzzle
bad muzzle
```

Current phone-side thresholds:

```text
minimum good muzzle confidence: 0.50
minimum bad muzzle confidence: 0.45
bad dominance margin: 0.12
minimum blur/sharpness score: 18
```

Capture logic:

```text
camera frame
-> TFLite muzzle detector finds muzzle box
-> if best class is bad muzzle, reject
-> if good confidence is too low, reject
-> crop the detected muzzle
-> check crop sharpness
-> if blurry, reject
-> apply local contrast enhancement
-> upload only accepted crop
```

Why blur rejection is important:

```text
blurred muzzle crops change the DINOv2 embedding
bad embeddings can reduce match accuracy
so blur images must not be saved or averaged
```

Current user-facing blur message:

```text
Image is blurry. Hold steady and show a clean straight muzzle.
```

## 7. Production Android Direction

The production Android app should not call the backend for live detection and cropping.

Required Android offline flow:

```text
Android camera frame
-> YOLO TFLite runs on phone
-> good/bad muzzle check runs on phone
-> crop runs on phone
-> CLAHE/local enhancement runs on phone
-> only good crops are saved locally
-> separate upload screen sends records when internet is good
-> backend creates embeddings and saves Pinecone records
```

Reason:

```text
field internet can be slow
backend live cropping can delay capture
phone should reject bad images immediately
```

Recommended Android model location:

```text
android/app/src/main/assets/models/best.tflite
```

Current browser PWA limitation:

```text
best.tflite and the TFLite WASM files are stored locally in frontend assets.
The browser PWA still loads TensorFlow JS/TFLite loader scripts from CDN.
So first-use fully offline model loading is not guaranteed in the browser PWA.
For production Android, bundle the runtime and best.tflite inside the APK assets.
```

## 8. Backend Image Save

When the phone sends an accepted crop, the frontend sends:

```text
clientProcessed=true
```

That tells the backend:

```text
image is already cropped by phone
do not run backend YOLO crop again
save the crop as muzzle1/muzzle2/muzzle3
```

The backend still has server-side support for older browser/manual testing, but the target field flow is phone-side processing.

## 8A. Field Reliability Fixes In Current Build

The current field build includes these important production fixes:

```text
Cattle Search start action stays visible above the mobile bottom nav.
Use GPS auto-runs GPS farmer search on the find-farmer screen.
Offline sync stores the server cattle ID and resumes the same capture on retry.
Offline sync sends the same offline capture ID to the backend so retries do not create new sessions.
Offline sync preserves the selected search radius instead of forcing 7 km.
Records left in syncing state are recovered to pending on app start.
Offline 3-muzzle capture advances to supporting image capture.
Fallback camera mode records capture duration correctly.
```

Workflow separation fixes:

```text
Cattle Enrolment duplicate match -> warns that the cow already exists.
Cattle Enrolment duplicate match -> is not saved as cattle_search evidence.
Cattle Search match/no-match -> saved as cattle_search evidence for admin review.
Admin field-test metrics count only workflow=cattle_search records.
```

## 9. Embedding Creation

For each accepted muzzle crop:

```text
muzzle1 -> DINOv2 embedding 1
muzzle2 -> DINOv2 embedding 2
muzzle3 -> DINOv2 embedding 3
```

Then backend averages them:

```text
average embedding = mean(embedding1, embedding2, embedding3)
```

The average embedding represents that one enrolment/search capture.

Why average:

```text
one image can have small lighting or angle variation
averaging 3 good crops gives a more stable cattle representation
```

Bad or blurry images should not enter this average.

## 10. Local-First Capture And Manual Upload

The Android field app saves capture data on the phone first, whether internet is available or not.

During capture:

```text
agent can start a capture
record metadata is stored in IndexedDB
accepted muzzle crops are stored locally
supporting images are stored locally
the record remains a draft and cannot upload
record is completed locally
```

After the officer finishes all 10 images:

```text
the draft becomes ready to upload
Home shows Upload Pending Records
the officer uploads only when internet is reliable
sync service creates the server enrolment/search record
uploads the saved muzzle crops
uploads the saved supporting images
completes the record
keeps failed records for retry
```

This keeps camera capture fast and protects field testing from temporary network drops. Reconnecting to internet does not upload records automatically.

Important production boundary:

```text
This is browser/PWA offline storage.
The final native Android app should implement the same behavior using native local storage and a dedicated upload screen.
```

## 11. Pinecone Namespaces

The app keeps enrolment and search evidence separate.

```text
vacapay-cattle-enrolment
vacapay-cattle-search
```

### Cattle Enrolment Namespace

Stores clean registered cattle identities.

Used as the search gallery.

### Cattle Search Namespace

Stores field search evidence.

Not used as the main identity gallery.

This prevents test/search captures from polluting the registered cattle database.

## 12. Cattle Search Matching

When a cattle search is captured:

```text
3 good muzzle crops
-> create 3 DINOv2 embeddings
-> average into 1 search embedding
-> compare against registered cattle embeddings
-> return ranked candidates
```

Search order shown to the agent/admin:

```text
1. selected farmer cattle
2. all registered cattle
```

Candidate source tags:

```text
farmer_cattle
all_other_muzzle
```

`farmer_cattle` means the match came from the selected farmer's saved cows.

`all_other_muzzle` means the match came from the wider registered cattle database.

The app keeps one best rank per cattle identity, so the same cow should not fill multiple Top-K positions.

## 13. Cattle Search Results

The app result can be:

```text
Cattle Found
No Cattle Found
```

Backend decision names:

```text
matched_existing
new_cattle
```

In Cattle Search:

```text
matched_existing -> save search record as cattle found
new_cattle -> save search record as no cattle found
```

Important:

```text
Cattle Search never creates registered cattle automatically.
If no cattle found is incorrect, admin marks it incorrect.
If cattle found is incorrect, admin marks it incorrect.
```

## 14. Admin Dashboard

The main admin dashboard answers the field testing question:

```text
How many cattle were enrolled?
How many searches were done?
For cattle found results, how many were correct or incorrect?
For no cattle found results, how many were correct or incorrect?
```

Main metrics:

```text
Registered Cattle
Cattle Searches
Reviewed Searches
Cattle Found Results
Found Correct
Found Incorrect
No Cattle Found Results
No Found Correct
No Found Incorrect
Pending Review
Top-1 Accuracy
Top-5 Accuracy
```

Top-1 and Top-5 are still useful model metrics, but the main business result is found/not-found correct or incorrect.

Additional production review tools:

```text
decision filter
field officer filter
enrolment coverage by field officer
searched/not-searched cattle filter
cow-level search count and last search date
CSV export
CSV includes capture duration and model/build versions
side-by-side review layout
loaded enrolled-cattle images for matched candidates
```

Enrollment Search Coverage counts unique registered cattle identities, not raw search attempts. If one cow is searched three times, its row shows three searches but it contributes one searched cow to coverage. Before review, a valid matched cattle ID counts provisionally. After review, the admin-confirmed cattle ID is authoritative. A search confirmed as a genuinely new cow does not reduce the not-searched count for any enrolled cow.

## 15. Admin Review

Admin reviews each cattle search record.

Each review card shows:

```text
search record ID
farmer name
officer name
app result
confidence score
Top-20 candidate cattle list
captured muzzle and supporting images
capture duration in seconds
app build version
TFLite muzzle model version
DINOv2 model version
embedding threshold used for that result
```

Admin actions:

```text
Correct - Cattle Found
Incorrect - Cattle Found
Correct - No Cattle Found
Incorrect - Cattle Exists
Register As New Cow
```

Use `Correct - Cattle Found` when the app found the right registered cow.

Use `Incorrect - Cattle Found` when the app matched the wrong cow.

Use `Correct - No Cattle Found` when the cow is actually not registered.

Use `Incorrect - Cattle Exists` when the app said no cattle found but the cow exists in registered cattle.

Use `Register As New Cow` only when admin wants to move a search record into registered cattle after review.

## 16. Security And Access

The backend uses signed login tokens.

Protected actions include:

```text
farmer search
cattle list/search
cattle enrolment creation
muzzle upload
supporting image upload
record completion
admin review
agent creation
ZIP download
merge/correction actions
```

Public status endpoints remain available for operational checks:

```text
/api/health
/api/version
/api/embedding/status
/api/pinecone/status
```

## 17. Officer Field Test Target

For field testing, a simple target per officer is:

```text
50 cattle enrolments
50 cattle searches
```

For 10 officers:

```text
500 cattle enrolments
500 cattle searches
```

The 50 cattle searches should include:

```text
already enrolled cows where correct answer is cattle found
new cows where correct answer is no cattle found
```

## 18. Correct Usage Examples

### New farmer, first cow

```text
Add Farmer + Enrol Cow
-> enter farmer name
-> use GPS
-> capture 3 good muzzle images
-> capture 7 supporting images
-> save
-> registered cattle count increases
```

### Same farmer, another new cow

```text
Add Cow To Farmer
-> search farmer by GPS/name
-> select farmer
-> capture cow
-> save
-> registered cattle count increases
```

### Same cow checked again

```text
Cattle Search
-> search/select farmer
-> capture same cow
-> app should return cattle found
-> admin marks correct or incorrect
-> registered cattle count does not increase
```

### New cow during search test

```text
Cattle Search
-> search/select farmer
-> capture a cow that was never enrolled
-> app should return no cattle found
-> admin marks correct no cattle found
-> registered cattle count does not increase
```

## 19. Why The UI Was Changed

The previous UI mixed these ideas:

```text
existing farmer
existing cattle
duplicate evidence
visit-based wording
new cattle
ground truth
```

That was confusing for agents and admin.

The current UI separates work into:

```text
Add Farmer + Enrol Cow
Add Cow To Farmer
Cattle Search
Admin Review
```

This matches the real field test plan and makes it clear when registered cattle should increase and when only a search record should be saved.
