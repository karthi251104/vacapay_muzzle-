# Vacapay Muzzle Field Testing App

Vacapay Muzzle is a cattle muzzle field-testing app with two workflows:

- Cattle Enrolment: register a cattle identity that will be used for future search.
- Cattle Search: test a cattle against enrolled cattle. The correct result can be a matched cattle or no cattle found.

The field direction is offline-first: Android should run YOLO muzzle detection, good/bad quality classification, cropping, and CLAHE on the phone. The backend should receive only good cropped muzzle images during upload, create DINOv2 embeddings, and save/search vectors in Pinecone.

## Current App Flow

- Add farmer or search existing farmer by GPS/name.
- Farmer ID is unique and non-sequential, for example `FARM-A7K9Q2M4`.
- Capture 3 good muzzle images for faster field testing.
- Capture 7 supporting images: face, side, back, udder.
- Backend creates one averaged DINOv2 embedding from the 3 muzzle images.
- Cattle search checks selected farmer cattle first, then all enrolled cattle.
- Results are tagged as `farmer_cattle` or `all_other_muzzle`.

## Offline Android Requirement

Production Android capture should work like this:

```text
Android camera frame
-> YOLO TFLite detects muzzle box offline
-> good/bad classifier accepts only usable muzzle crops
-> Android crops muzzle
-> Android applies CLAHE
-> Android saves only good cropped images locally
-> upload screen sends records when internet is good
-> backend creates DINOv2 embeddings
-> backend saves/searches Pinecone
```

Recommended Android model locations:

```text
android/app/src/main/assets/models/muzzle_detector.tflite
android/app/src/main/assets/models/muzzle_quality_classifier.tflite
```

The current web app still keeps backend YOLO as a browser-testing fallback. Android uploads can send `clientProcessed=true` to save already-cropped muzzle images without backend YOLO cropping.

## Backend And Pinecone

- Cattle enrolment vectors go to the cattle enrolment Pinecone namespace.
- Cattle search vectors go to the cattle search Pinecone namespace.
- Pinecone search queries the cattle enrolment namespace so search evidence does not pollute the main identity database.
- If no match is above threshold, the search result is no cattle found/new cattle.

## Admin Evaluation

Admin reviews cattle search records and sets ground truth:

- Correct Match: predicted cattle is the expected cattle.
- Wrong Match: predicted cattle is different from expected cattle.
- Missed Match: app said no cattle found, but ground truth was an enrolled cattle.
- Correct No Cattle Found: app said no cattle found and the captured cattle was actually new.

Metrics shown:

- Registered Cattle
- Cattle Searches
- Reviewed Searches
- Correct Matches
- Correct No Cattle Found
- Missed Matches
- Wrong Matches
- Top-1 Accuracy
- Top-5 Accuracy
- False Matches
- Officer-wise quality

For field testing, each officer can do 50 cattle enrolments and 50 cattle searches. In the search set, include both already-enrolled cattle and new cattle where the expected answer is no cattle found.

## Details

See [docs/COMPLETE_WORKFLOW_AND_EVALUATION.md](docs/COMPLETE_WORKFLOW_AND_EVALUATION.md) for the full start-to-end workflow.
See [docs/FIELD_TESTING_PROGRESS.md](docs/FIELD_TESTING_PROGRESS.md) for the current progress summary.
