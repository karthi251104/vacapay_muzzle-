# Vacapay Muzzle Field Testing Progress

Date: 2026-06-30
App: Vacapay cattle muzzle identification field test app
Current purpose: Clean field-testing workflow for cattle muzzle recognition, duplicate detection, and dataset-style validation.

Complete workflow, backend process, Pinecone search, and metric formulas are documented in:

```text
docs/COMPLETE_WORKFLOW_AND_EVALUATION.md
```

## 1. Project Goal

The app is built to test whether cattle can be identified using muzzle images in real field conditions.

The main test case is:

1. A field agent visits a farmer.
2. The agent records farmer details, GPS location, and cattle photos.
3. The agent captures 5 muzzle images and 7 supporting cattle images.
4. After some time, the agent may visit again.
5. Weather, lighting, location accuracy, farmer name entry, or officer entry may change.
6. The app should still identify whether the cow is already enrolled.

The app is now structured as a testing system, not only a basic registration system.

## 2. Fresh Data Reset Completed

All old test records were removed so testing can start from a clean state.

Reset completed for:

- Local cattle folders under `data/`
- Local muzzle image folders
- Local `enrollments.json`
- Local `match_audits.json`
- MongoDB `cattle` collection
- MongoDB `match_audits` collection
- Pinecone muzzle embeddings in namespace `vacapay`
- Cloudinary cattle images are not shown after reset because metadata was cleared; remote cleanup can be done separately if storage cleanup is needed

Kept safely:

- Admin and agent users in `users.json`
- YOLO model file
- DINOv2 muzzle embedding model file
- Runtime/model support folders

Verified clean state:

- Farmers: 0
- Unique cattle: 0
- Duplicate captures: 0
- Images: 0
- Pinecone vector count: 0

## 3. Current Public Test Link

Cloudflare quick tunnel link at reset time:

<https://strong-thought-consistency-charge.trycloudflare.com>

Note: This is a Cloudflare quick tunnel URL. It can change if the tunnel process restarts.

## 4. Main User Roles

### Field Agent

The field agent uses the mobile-friendly flow to:

- Add a new farmer
- Search an existing farmer
- Capture GPS
- Enroll cattle
- Capture muzzle images
- Capture supporting cattle images
- Submit the record
- See whether the cow is new or duplicate

### Admin

The admin uses the web dashboard to:

- View agents
- View the unique cattle dataset
- View duplicate evidence captures
- Inspect folders, visits, and photos
- Download selected images
- See top match audit results
- Review real field ground truth and accuracy results
- Move wrong automatic matches back into registered cattle

## 5. Updated Agent Flow

The first page is now clearer and starts with farmer selection.

Agent sees two main choices:

1. Add Farmer
2. Search Farmer

### Add Farmer Flow

Used when the farmer is new.

Steps:

1. Enter farmer ID or farmer name.
2. Capture GPS.
3. Start first cow enrollment.
4. Capture 5 muzzle photos.
5. Capture 7 supporting photos.
6. Save record.

Important behavior:

- GPS is required before starting capture.
- Farmer ID or farmer name is required.
- The first cow becomes part of the unique cattle database if no match is found.

### Existing Farmer Flow

Used when the farmer is already registered.

Search options:

- Search by GPS location
- Search by farmer name or farmer ID

Expected behavior:

- If multiple farmers are created in the same location, GPS search should list all nearby farmers.
- Name search should list matching farmers by farmer name or farmer ID.
- Agent selects the correct farmer before starting cattle capture.

## 6. Muzzle Matching Logic

The muzzle search is not limited only to the selected farmer.

When 5 muzzle images are captured, the app checks:

1. Selected farmer cattle records
2. All saved muzzle records in the full database

This is important for field testing because the same cow can be mistakenly captured under another farmer name or farmer ID.

### Match Source Tags

Backend matches are tagged as:

- `farmer_cattle`: match came from selected farmer cattle records
- `all_other_muzzle`: match came from the wider saved muzzle database

The UI tells the agent/admin where the match was found.

## 7. Top 1 and Top 5 Testing Logic

The app now behaves closer to the test dataset workflow.

For each muzzle check, the backend prepares top match candidates:

- Top 1 best match
- Top 5 match candidates
- Cattle ID
- Farmer name
- Match score
- Match source
- Cattle label

This helps compare the app behavior with previous offline testing where top-k accuracy was checked.

## 8. Real Field-Test Scoring Logic

The admin result dashboard now follows the same logic as the old offline folder test script.

```text
query_label in folder test = expected cow in field
top_matches in folder test = app score-ranked Top-1/Top-5 prediction
admin confirmation = ground truth for real field
```

In real field testing, the app does not know the expected cow automatically. The admin sets that truth by reviewing the saved muzzle, face, and side images.

Admin `Muzzle Match History` shows:

- Registered Cattle
- Repeat Visits
- Reviewed Ground Truth
- Correct Re-visits
- Missed Matches
- Wrong Matches
- Top-1 Accuracy
- Top-5 Accuracy
- False Matches
- Needs Expected Cow

Officer-wise table shows:

- Officer
- Repeats
- Reviewed
- Correct
- Missed
- Wrong
- Top-1
- Top-5
- Quality

Rules used by the dashboard:

- A good-score automatic match is saved as duplicate evidence.
- If admin confirms it is correct, it counts as a correct re-visit.
- If admin sees the automatic match is wrong, admin clicks `Wrong - make registered`.
- That wrong capture is moved out of duplicate evidence and becomes a registered cattle record.
- The result then counts as a wrong match / false match.
- If the app saves a cow as new but admin marks an expected older cow from Top-1, it counts as a missed match.
- First-time new cattle are not counted as missed repeat visits unless admin marks them as an expected older cow.
- Top-5 candidate tags highlight the expected cow after admin confirmation.

## 9. Duplicate Handling

Old behavior was confusing because repeated captures could look like normal cattle visits or separate main records.

New behavior:

- If the same cow is detected, the app does not merge it into the original record automatically.
- The original cow remains in the unique cattle database.
- The new capture is saved separately as duplicate evidence.
- The duplicate record stores which original cattle it matched.

This makes testing clearer because every duplicate event is visible and auditable.

### Duplicate Record Stores

A duplicate evidence record includes:

- Its own cattle/session folder
- Matched original cattle ID
- Matched original farmer name
- Top match candidates
- Match confidence
- Match source
- Captured images

## 10. Admin UI Changes

Admin dashboard has been changed to a testing registry.

New dashboard title:

- Testing Dataset Registry

Admin stats now show:

- Agents
- Farmers
- Unique cattle
- Duplicate captures
- Total records
- Images

### Admin Registry Tabs

The cattle registry is split into two tabs.

#### Unique Cattle Database

This tab shows only real unique cattle records.

Use this as the main dataset count.

#### Duplicate Capture Evidence

This tab shows captures that matched existing cattle.

Each duplicate is stored separately and linked to the original cow.

This avoids confusion in demos and testing.

## 11. Agent UI Changes

Agent home now clearly communicates the field process.

It shows:

- Add Farmer
- Search Farmer
- Farmers count
- Unique cattle count
- Capture count
- Duplicate count
- Recent unique cattle

During matching, messages explain:

- Whether the app checked selected farmer cattle records
- Whether the app checked all saved muzzle records
- Whether the result was a new cow or duplicate evidence

## 12. Backend Changes

Important backend changes:

- Farmer search supports GPS and farmer name/ID.
- Cattle search supports farmer ID or farmer name.
- Enrollment requires GPS before starting capture.
- Muzzle matching checks all saved muzzle records, not only same farmer records.
- Matches are tagged with `farmer_cattle` or `all_other_muzzle`.
- Duplicate matches are saved separately with `duplicate_saved_separately` status.
- Duplicate evidence records are excluded as future canonical match candidates.
- Stats separate unique cattle and duplicate captures.
- Pinecone matching is no longer limited only to farmer filter.
- Admin review API supports `move_out_as_registered` for wrong automatic matches.
- Wrong automatic matches can be converted from duplicate evidence into registered cattle records.

## 13. Frontend Changes

Important frontend changes:

- First page is reorganized around Add Farmer and Search Farmer.
- Existing farmer search shows GPS results and name/ID results.
- Admin table no longer mixes unique cattle and duplicate evidence in one confusing list.
- Admin can switch between Unique Cattle Database and Duplicate Capture Evidence.
- Match result text explains where the match came from.
- Color theme changed to a cleaner blue/white testing-tool style.
- Duplicate evidence is highlighted with a separate amber visual style.
- Admin match history shows field-test result cards and officer-wise result table.
- Admin can inspect evidence photos, confirm correct matches, mark expected Top-1, or move a wrong automatic match into registered cattle.

## 14. Data Model Concept

The app now separates records into two ideas.

### Unique Cattle

A unique cattle record is treated as the canonical cow in the dataset.

It is used for future matching.

### Duplicate Evidence

A duplicate evidence record is a new field capture that matched an existing cow.

It is saved separately for testing and review.

It is not used as the main cow identity.

## 15. Recommended Demo

Use this sequence for the demo.

### Step 1: Show Fresh Dashboard

Open the app and login as admin.

Show:

- Farmers: 0
- Unique cattle: 0
- Duplicate captures: 0
- Pinecone vectors: 0

Explain that testing is starting fresh.

### Step 2: Add Farmer A

Login as agent.

Click:

- Add Farmer

Enter:

- Farmer name
- Farmer ID
- GPS

Start first cow capture.

### Step 3: Enroll Cow 1

Capture:

- 5 muzzle images
- 7 supporting cattle photos

Save the record.

Expected result:

- Cow is saved as new unique cattle.
- Admin Unique Cattle Database shows 1 cow.

### Step 4: Create/Search Farmer B

Use same GPS location for testing.

Either:

- Add Farmer B, or
- Search existing farmer by GPS/name

Explain that GPS can return multiple farmers in the same place during testing.

### Step 5: Capture Same Cow Again

Capture the same cow muzzle again under Farmer B or another farmer context.

Expected result:

- App checks selected farmer cattle records.
- App also checks all saved muzzle records.
- If the same cow is matched, it is saved as duplicate evidence.

### Step 6: Show Admin Result

Open admin dashboard.

Show:

- Unique Cattle Database still contains original cow.
- Duplicate Capture Evidence contains the repeated capture.
- Duplicate record shows original matched cattle/farmer.
- Match source tells whether it came from farmer cattle or all saved muzzle records.
- Muzzle Match History shows Top-1/Top-5 candidates and field result metrics.
- Admin reviews photos and marks the repeat as `Correct` if the automatic match is right.
- If the automatic match is wrong, admin clicks `Wrong - make registered`; the capture moves into registered cattle and the dashboard counts it as wrong/false match.

## 16. What This Proves

The demo proves:

- The agent flow is clear.
- Farmer can be added or searched by GPS/name.
- Multiple farmers can exist in the same test location.
- Muzzle matching is not restricted to only one farmer.
- Same cow under another farmer can still be detected.
- Duplicate captures are saved separately for testing.
- Unique cattle dataset remains clean.
- Top 1 and Top 5 matching information is available.
- Admin ground truth can calculate real field accuracy.
- Wrong automatic matches can be corrected without deleting the capture.

## 17. Current Verification

Already verified after implementation:

- Backend syntax check passed.
- Frontend build passed.
- Backend restarted successfully.
- Cloudflare tunnel is running at the current quick tunnel link.
- Health endpoint is OK.
- Authenticated cattle API returns zero records after reset.
- Pinecone namespace `vacapay` returns zero vectors after reset.

## 18. Files Updated

Backend:

- `backend/src/server.js`

Frontend:

- `frontend/src/app/api.service.ts`
- `frontend/src/app/app.component.ts`
- `frontend/src/app/app.component.html`
- `frontend/src/app/app.component.css`

Documentation:

- `docs/FIELD_TESTING_PROGRESS.md`

## 19. Known Notes

- Cloudflare quick tunnel URLs are temporary and can change after restart.
- The first enrolled cow after reset has no previous muzzle to compare against.
- Matching becomes meaningful from the second capture onward.
- Duplicate behavior depends on the current embedding threshold.
- Current threshold is 0.70 in backend health configuration.
- Cloudinary remote files may remain even after metadata reset unless a separate remote storage cleanup is run.

## 20. Short Explanation

This app is now structured like a real field test dataset system.

The unique cattle database stores the main cattle identities. When a cow is captured again, the app checks both the selected farmer's cattle and the full muzzle database. If it finds the same cow, it saves the new capture separately as duplicate evidence instead of mixing it into the main record. Admin then reviews the saved evidence photos and sets the real field ground truth. Correct automatic matches count as correct re-visits. Wrong automatic matches can be moved back into registered cattle and count as wrong or false matches. This keeps the testing dataset clean and makes field accuracy measurable.
