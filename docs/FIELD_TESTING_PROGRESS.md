# Field Testing Progress

## Current Direction

The app has been aligned to the field-testing direction:

```text
Cattle Enrolment
Cattle Search
```

The old repeat-visit wording has been removed from user-facing workflow text.

## Implemented In This Repo

- Muzzle requirement changed from 5 to 3 images.
- Backend supports `MUZZLE_IMAGE_COUNT` with default value `3`.
- Backend can accept Android/client-preprocessed muzzle crops using `clientProcessed=true`.
- Client-preprocessed crops are saved without backend YOLO cropping.
- Backend still keeps YOLO fallback for current browser testing.
- Farmer IDs are now unique and non-sequential.
- Cattle enrolment vectors and cattle search vectors use separate Pinecone namespaces.
- Pinecone search queries the cattle enrolment namespace.
- Admin metrics now use cattle search wording.
- Admin can mark `Correct No Cattle Found` for new-cattle search results.

## Android Work Still Needed

This repo does not contain the native Android offline inference project yet.

Android app should add:

```text
YOLO TFLite muzzle detector
Good/bad muzzle quality classifier
On-device crop
On-device CLAHE
Offline local save
Separate upload screen
```

Recommended model paths:

```text
android/app/src/main/assets/models/muzzle_detector.tflite
android/app/src/main/assets/models/muzzle_quality_classifier.tflite
```

## Backend Role

Backend should do:

```text
receive uploaded good crops
save images
create DINOv2 embeddings
average 3 muzzle embeddings
search enrolled cattle vectors
save result
write Pinecone
```

Backend should not be required for real-time field capture once Android offline inference is ready.

## Admin Review

Admin verifies cattle search records and sets ground truth:

```text
Correct Match
Wrong Match
Missed Match
Correct No Cattle Found
```

This supports real field testing where a search can be for an enrolled cattle or a new cattle.

## Field Target

Per field officer:

```text
50 cattle enrolments
50 cattle searches
```

For 10 officers:

```text
500 cattle enrolments
500 cattle searches
```
