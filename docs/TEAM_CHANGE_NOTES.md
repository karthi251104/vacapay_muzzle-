# Team Change Notes

This note explains the recent changes in simple terms so another developer or reviewer can understand the current flow.

## 1. Main Workflow Names

The app now uses two workflow names:

- Cattle Enrolment
- Cattle Search

We removed the wording "repeat visit" from the main flow because a cattle search may find an existing cattle or may correctly return no cattle found.

## 2. Field Testing Flow

For fast field testing, the app is set to capture 3 muzzle images instead of 5.

Current intended flow:

1. Field officer enrols cattle under a farmer.
2. The app saves clean cattle enrolment data.
3. Later, field officer performs cattle search.
4. Search image embeddings are compared against saved enrolment embeddings.
5. Admin can review whether the result was correct, wrong, missed, or correctly no cattle found.

## 3. Android Offline Processing Plan

The planned production Android flow is:

1. YOLO muzzle detection runs inside Android.
2. Good/bad muzzle quality classification runs inside Android.
3. Only good muzzle crops are accepted.
4. CLAHE enhancement is applied inside Android.
5. Cropped good muzzle images are stored locally.
6. Upload happens later from a separate upload screen when internet is good.
7. Backend receives already processed images, creates embeddings, and saves to Pinecone.

This avoids slow backend crop/classification calls in low-network field areas.

## 4. Backend Search Logic

For a cattle search:

1. The new muzzle images are converted into embeddings.
2. The visit/search embedding is compared against saved cattle enrolment embeddings.
3. Results are grouped so one cattle identity appears only once in Top-K.
4. Top-1 and Top-5 results are stored for evaluation.

The backend separates:

- cattle enrolment records
- cattle search records

This keeps the clean enrolled cattle database separate from testing/search evidence.

## 5. Admin Metrics

Admin metrics are now aligned to field testing:

- Total cattle enrolled
- Total cattle searches
- Correct matches
- Wrong matches
- Missed matches
- Correct no cattle found
- Top-1 accuracy
- Top-5 accuracy
- Officer-wise capture quality

For new cattle in a search, the correct expected result can be "no cattle found".

## 6. LLM Verification Experiment

Created a Groq vision dashboard to test the suggested LLM verification idea.

Dashboard folder:

```text
groq-muzzle-dashboard/site
```

Open:

```text
groq-muzzle-dashboard/site/index.html
```

What it shows:

- Query muzzle image
- Top-1 to Top-5 candidate muzzle images
- Groq selected match
- Confidence
- Reason
- Matching pattern boxes drawn on the collage

Small test result:

- 5 samples tested
- Groq selected Top-1 for all 5

Important: this is a small controlled LLM verification demo. The final real experiment should use Top-5 candidates produced by the DINOv2 embedding model, then send those Top-5 collages to Groq/Gemini for verification.

### Shuffled Top-10 Follow-up

A second dashboard was created after the request to remove rank hints:

```text
groq-muzzle-dashboard/site_shuffled_top10
```

This version:

- uses 10 candidate muzzle images
- randomly shuffles the candidate order
- removes Top-1 / Top-2 labels from the collage
- shows only class names on candidate images
- asks Groq to select the matching class

Small test result:

- 5 samples tested
- Groq correctly selected the query class for 3 out of 5 samples

This is a better stress test than the first Top-5 demo because the model cannot use rank labels as hints.

## 7. Current Limitation

The local full DINOv2 all-image evaluation did not complete on this Windows machine because PyTorch needs the Microsoft Visual C++ runtime to load correctly.

Once that runtime is installed, the full flow should be:

```text
test query image
-> DINOv2 embedding search
-> real Top-5 candidates
-> collage generation
-> Groq/Gemini verification
-> dashboard metrics
```
