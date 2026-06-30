# Vacapay Muzzle Complete Workflow And Evaluation Guide

Date: 2026-06-30
Purpose: Explain the complete app workflow, backend processing, Pinecone search, admin review, and field-test metric calculation.

This document is written so a new reviewer, developer, tester, or field coordinator can understand what the app does from start to end.

## 1. Short Summary

The app is a field-testing system for cattle identification using muzzle images.

Simple pipeline:

```text
Agent selects/adds farmer
-> Agent captures GPS
-> Agent captures 5 muzzle images
-> Backend crops each muzzle with YOLO
-> Backend creates one DINOv2 embedding per crop
-> Backend averages the 5 embeddings into one visit embedding
-> Backend searches selected farmer cattle and all saved cattle muzzles
-> App saves the capture as new cattle or matched re-visit
-> Admin reviews photos and sets ground truth
-> Dashboard calculates field accuracy
```

The app uses farmer-first review for field usability, but metric accuracy uses raw score-ranked Top-1/Top-5 results like the offline folder test script.

## 2. Main Parts Of The System

### Frontend

Location:

```text
frontend/src/app/app.component.ts
frontend/src/app/app.component.html
frontend/src/app/app.component.css
frontend/src/app/api.service.ts
```

Responsibilities:

- Agent login and admin login.
- Add farmer and search farmer UI.
- Mobile camera capture flow.
- Capture 5 muzzle images.
- Capture 7 supporting images.
- Show match result to the agent.
- Admin registry and match history dashboard.
- Admin review and field metric calculation.

### Backend

Location:

```text
backend/src/server.js
backend/scripts/embedding_average.py
backend/scripts/embedding_status.py
backend/scripts/yolo_status.py
```

Responsibilities:

- Create enrollments.
- Validate GPS before capture.
- Save metadata.
- Save image references.
- Run YOLO muzzle crop.
- Run DINOv2 embedding average.
- Upsert vectors into Pinecone.
- Query Pinecone and local candidates.
- Store match audit records.
- Handle admin correction actions.

### Storage

The app uses multiple storage layers:

```text
MongoDB Atlas       -> cattle metadata, users, match audits
Local data folder   -> fallback JSON, local images, runtime files
Cloudinary          -> remote image storage for viewing/downloading
Pinecone            -> muzzle embedding vector search
```

Local fallback files:

```text
data/enrollments.json
data/match_audits.json
data/users.json
```

Mongo collections:

```text
cattle
users
match_audits
```

## 3. Start-To-End Agent Workflow

## Step 1: Agent Opens App

Agent logs in from mobile.

The home page shows two main options:

```text
Add Farmer
Search Farmer
```

Use `Add Farmer` for a farmer not yet registered.
Use `Search Farmer` for a farmer already created.

## Step 2: Add Farmer

When the agent clicks `Add Farmer`, the app generates a farmer ID.

Example:

```text
FARM-0001
FARM-0002
FARM-0003
```

Important behavior:

- Farmer ID is global across all agents.
- If Agent 1 already created `FARM-0010`, Agent 2 should get `FARM-0011`.
- Frontend shows a generated ID for clean UI.
- Backend makes the final decision for new farmer ID using all saved records.
- This prevents duplicate farmer IDs when different agents work at the same time.

The agent enters:

```text
Farmer name
GPS location
Field officer name is filled from login
```

GPS is required before cattle capture.

If GPS is missing:

```text
Backend blocks enrollment.
Message: Use GPS first before starting cow capture.
```

## Step 3: Start First Cow Under Farmer

After farmer name and GPS are ready, the agent starts the first cow.

Backend creates:

```text
cattleId
sessionId
farmerId
farmerName
fieldOfficerName
locationLat/locationLon
folderLocation
captureDateTime
```

The first cow capture creates a new cattle folder/session.

## Step 4: Capture 5 Muzzle Images

Agent captures 5 muzzle images.

For each muzzle image:

```text
phone image
-> backend receives image
-> YOLO detects muzzle box
-> backend crops muzzle
-> CLAHE enhancement is applied after crop
-> crop is saved as muzzle1.jpg ... muzzle5.jpg
-> image reference is stored
-> image may be uploaded to Cloudinary
```

YOLO is only for muzzle detection/cropping.
YOLO does not identify the cow.

If YOLO cannot detect the muzzle clearly:

```text
image is rejected
agent must retake
embedding is not created for that bad image
```

## Step 5: DINOv2 Embedding Creation

After the 5th muzzle crop is saved, backend starts matching.

For each of the 5 muzzle crops:

```text
muzzle crop -> DINOv2 triplet model -> embedding vector
```

An embedding is a numeric vector representing muzzle identity.

Meaning:

```text
same cattle muzzle       -> vectors should be close
different cattle muzzle  -> vectors should be far
```

The app uses:

```text
backend/dinov2_triplet_v2_best.pt
```

## 6. What Is Average Embedding?

Each visit has 5 muzzle crops.

The backend creates 5 embeddings:

```text
muzzle1 -> embedding1
muzzle2 -> embedding2
muzzle3 -> embedding3
muzzle4 -> embedding4
muzzle5 -> embedding5
```

Then it averages them:

```text
average = mean(embedding1, embedding2, embedding3, embedding4, embedding5)
average = L2 normalize(average)
```

This is done in:

```text
backend/scripts/embedding_average.py
```

Why average is used:

- One image can be slightly blurred.
- One image can have bad light.
- One image can have a small angle change.
- Average embedding gives a more stable visit identity.

The final visit embedding is what gets compared with saved cattle.

## 7. Pinecone Storage

Pinecone stores muzzle embeddings for vector search.

Vector ID format:

```text
cattleId__sessionId
```

Pinecone metadata stored with each vector:

```text
cattleId
sessionId
farmerId
farmerIdNorm
farmerName
farmerNameNorm
fieldOfficerName
locationLat
locationLon
captureDate
folderLocation
```

Pinecone namespace:

```text
vacapay
```

Index dimension:

```text
768
```

Similarity metric:

```text
cosine
```

## 8. Where Muzzle Search Happens

When the 5th muzzle is captured, the backend prepares match candidates.

It checks:

```text
1. Selected farmer cattle
2. All other saved cattle muzzles
```

Each candidate gets a source tag:

```text
farmer_cattle
all_other_muzzle
```

Meaning:

```text
farmer_cattle      -> match belongs to the selected farmer
all_other_muzzle   -> match belongs to another farmer / full database
```

Why both are needed:

- Usually the cow belongs to the selected farmer.
- But in real field testing the same cow may be wrongly entered under another farmer.
- Full database search catches that mistake.

## 9. Search Order And Ranking

The app does two useful things at the same time.

### For Field Usability

The app prioritizes selected farmer matches when there is a strong farmer match.

This helps the agent/admin understand the result easily:

```text
This cow matched under the selected farmer.
```

### For Accuracy Metrics

The app also stores raw score-ranked Top-1/Top-5 matches.

This is required to match the offline folder test logic:

```text
query_label = expected cow
top_matches = score-ranked predictions
```

So the app keeps two lists:

```text
topMatches        -> farmer-priority display list
rankedTopMatches  -> raw score-ranked metric list
```

Admin Top-1 and Top-5 accuracy uses:

```text
rankedTopMatches
```

This is important. If UI shows farmer match first for review, that should not change the scientific Top-k metric.

## 10. One Rank Per Cattle Identity

The offline folder script ranks gallery classes, not repeated image files.

So the app now keeps only the best candidate per cattle ID before Top-k evaluation.

Example:

```text
Cattle A session 1 -> 91%
Cattle A session 2 -> 88%
Cattle B session 1 -> 86%
```

Metric Top-k becomes:

```text
1. Cattle A -> 91%
2. Cattle B -> 86%
```

This prevents the same cattle from occupying multiple Top-5 positions.

## 11. Match Decision Logic

Current threshold:

```text
70%
```

Backend logic:

```text
if selected farmer has a strong match >= threshold:
    choose farmer_cattle match
else if best global match >= threshold:
    choose best all-database match
else:
    save as new cattle
```

### Case A: Strong Selected-Farmer Match

```text
best farmer cattle score >= 70%
```

Result:

```text
matched_existing
duplicate_saved_separately
source = farmer_cattle
```

### Case B: Strong Match Under Another Farmer

```text
no strong selected-farmer match
but all_other_muzzle score >= 70%
```

Result:

```text
matched_existing
duplicate_saved_separately
source = all_other_muzzle
```

This catches a cow already saved under another farmer.

### Case C: No Strong Match

```text
best score < 70%
```

Result:

```text
new_cattle
registered cattle record
```

## 12. What Gets Saved After Matching

### New Cattle

Saved as canonical registered cattle.

Used for future matching.

### Matched Re-visit / Duplicate Evidence

Saved separately from the original cattle.

It stores:

```text
new capture folder
matched original cattle ID
matched farmer name
confidence score
farmer_cattle/all_other_muzzle source
topMatches display list
rankedTopMatches metric list
captured images
```

Duplicate evidence is not used as a future canonical match candidate.

Reason:

```text
The unique cattle database should stay clean.
Repeated captures should be visible for testing and review.
```

## 13. Supporting Images

Each visit requires 7 supporting images:

```text
face1
face2
face3
leftside
rightside
back
udder
```

These are not used for embedding search.

They are used by admin to verify ground truth.

If supporting images are missing:

```text
record cannot be completed
admin review is weaker
field test quality is lower
```

## 14. Admin Dashboard Workflow

Admin dashboard has these important areas:

```text
Testing Dataset Registry
Unique Cattle Database
Matched Re-visits / Duplicate Evidence
Muzzle Match History
Officer-wise results
```

### Unique Cattle Database

Main cattle identities.

Used as gallery/database for future matching.

### Matched Re-visits

Repeat captures that auto-matched existing cattle.

Stored separately for testing.

### Muzzle Match History

Shows every match audit.

Admin can review:

```text
muzzle photos
face/side/body photos
score-ranked Top-5 candidates
matched cattle ID
farmer name
field officer
match source
```

## 15. Admin Ground Truth

In real field testing, the app does not automatically know truth.

Admin sets truth by reviewing images.

Offline folder test:

```text
query_label = known expected cow folder
```

Field app:

```text
expected cow = admin confirmed cattle ID
```

Admin actions:

### Correct

Use when the app matched the right existing cow.

Effect:

```text
correctCattleId = matchedCattleId
counts as correct re-visit
```

### Candidate Buttons (#1 to #5)

Use when admin wants to set the expected cow from the score-ranked Top-5 list.

Effect:

```text
correctCattleId = selected candidate cattleId
Top-1/Top-5 metrics update based on rankedTopMatches
```

### Expected Rank 1

Shortcut for setting expected cow to raw score-ranked rank 1.

### Wrong - make registered

Use when the app auto-matched a cow but the photos show it is actually a different/new cow.

Effect:

```text
duplicate evidence -> registered cattle
reviewStatus = wrong_moved_to_registered
counts as wrong match / false match
```

## 16. Field Metric Calculation

The app calculates metrics from admin-reviewed match audits.

### Registered Cattle

Number of canonical unique cattle records.

### Repeat Visits

Captures used as repeat-visit tests.

Includes:

```text
auto matched_existing captures
new_cattle captures only when admin marks an expected older cow
```

First-time new cattle are not counted as missed repeat visits unless admin marks them as an expected older cow.

### Reviewed Ground Truth

Repeat visits where admin has set expected cattle ID.

Formula:

```text
reviewed = repeat visits with correctCattleId set
```

### Correct Re-visits

App matched the correct existing cattle.

Formula:

```text
decision == matched_existing
and matchedCattleId == expectedCattleId
```

### Missed Matches

App saved as new cattle, but admin says it should have matched an existing cow.

Formula:

```text
decision == new_cattle
and expectedCattleId exists
```

### Wrong Matches

App auto-matched, but it matched the wrong cattle.

Formula:

```text
decision == matched_existing
and matchedCattleId != expectedCattleId
```

### False Matches

Same as wrong automatic matches.

Formula:

```text
falseMatchCount = wrongMatches
```

### Top-1 Accuracy

Expected cow is the first raw score-ranked prediction.

Formula:

```text
expectedCattleId == rankedTopMatches[0].cattleId
```

### Top-5 Accuracy

Expected cow appears anywhere in the first 5 raw score-ranked predictions.

Formula:

```text
expectedCattleId in rankedTopMatches[0:5]
```

### Needs Expected Cow

Repeat candidates that still need admin confirmation.

Formula:

```text
repeat candidate and no expectedCattleId
```

## 17. Difference Between Field Metrics And Offline Folder Test

Offline folder script:

```text
gallery class folders are known cattle IDs
query folder names are known labels
script returns score-ranked top matches
accuracy is calculated from query_label vs top_matches
```

Field app:

```text
registered cattle are gallery classes
new field captures are queries
admin confirmation creates query_label
rankedTopMatches are score-ranked top matches
```

This is the correct real-world adaptation.

## 18. Pinecone Failure Or Missing Vectors

If Pinecone is enabled and works:

```text
backend queries Pinecone
Pinecone returns nearest vectors
backend maps vector IDs back to prepared metadata candidates
```

If Pinecone fails:

```text
backend falls back to local cosine comparison against prepared candidates
```

This means matching can still work locally, but Pinecone is preferred for scalable search.

If vectors are missing:

```text
backend regenerates embeddings for candidate sessions when possible
backend upserts them to Pinecone
```

## 19. What Happens If You Do Or Do Not Do Each Step

### If Agent Does Not Use GPS

Enrollment is blocked.

Reason:

```text
GPS is required for field testing and farmer search.
```

### If Agent Does Not Enter Farmer Name

New farmer capture is blocked.

Reason:

```text
Farmer name is needed for selection and review.
```

### If Farmer ID Is Not Typed

No problem.

Reason:

```text
Farmer ID is generated automatically and globally.
```

### If Only 1 To 4 Muzzle Images Are Captured

No final matching happens.

Reason:

```text
matching starts after 5 muzzle crops.
```

### If YOLO Rejects A Muzzle Image

Agent must retake.

Reason:

```text
bad crop should not enter embedding matching.
```

### If Supporting Images Are Not Added

Final save is blocked.

Reason:

```text
admin needs support photos for ground truth.
```

### If Admin Does Not Review Repeat Visits

They remain pending.

Effect:

```text
not included in reviewed accuracy
shown under Needs Expected Cow
```

### If Admin Marks Wrong Auto Match As Registered

The duplicate evidence becomes registered cattle.

Effect:

```text
wrong match count increases
false match count increases
registered cattle count increases
```

### If Model Is Changed Later

Old embeddings cannot be trusted with the new model.

Required process:

```text
keep original images
regenerate embeddings for all cattle
clear or change Pinecone namespace
upsert new vectors
re-test threshold
```

## 20. Recommended Field Test Plan

For 10 field officers, a useful test target is:

```text
250 cattle enrolled
250 repeat visits
90%+ correct matched re-visits target
wrong match target very low, ideally 0
```

Track these metrics:

```text
Registered cattle
Repeat visits
Reviewed ground truth
Correct re-visits
Missed matches
Wrong matches
Top-1 accuracy
Top-5 accuracy
False matches
Needs expected cow
Officer-wise capture quality
```

Admin should review repeat visits daily.

Do not judge final accuracy only from auto results. Use admin-confirmed ground truth.

## 21. Good Explanations For Common Questions

### Why 5 muzzle images?

Because one field image can be affected by blur, light, angle, or camera shake. Five images allow a stable average embedding.

### Why save duplicate evidence separately?

Because field testing needs to count every repeat visit. If repeated captures are merged silently, accuracy cannot be audited.

### Why search all cattle after farmer cattle?

Because the same cow can be entered under another farmer by mistake. Farmer-first search is easy to understand, full database search is safer.

### Why use score-ranked Top-k for metrics?

Because offline test metrics use score-ranked predictions. UI can help humans by showing farmer context, but metrics must stay model-score based.

### What is the most important metric?

Wrong matches / false matches are most important for safety. Top-1 and Top-5 accuracy show model ability, but false match count shows risk.

## 22. Current Code Areas To Check During Future Changes

Backend:

```text
backend/src/server.js
resolveMuzzleMatch
queryPineconeMatches
upsertSessionVector
storeMatchAudit
moveMatchedVisitOutAsRegistered
nextFarmerId
```

Frontend:

```text
frontend/src/app/app.component.ts
fieldTestMetrics
officerFieldSummaries
isTopKCorrect
metricTopMatches
confirmMatchReview
moveWrongMatchToRegistered
```

Docs:

```text
README.md
docs/FIELD_TESTING_PROGRESS.md
docs/COMPLETE_WORKFLOW_AND_EVALUATION.md
```