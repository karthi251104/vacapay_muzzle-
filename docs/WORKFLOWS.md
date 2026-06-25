# Workflows

## 1. Admin Workflow

Admin can:

- log in
- create agents
- inspect uncertain matches
- confirm or correct match review

### Admin Flow

1. Admin logs in
2. Admin creates field agents
3. Agents receive phone/ID and password
4. Admin later reviews uncertain match cases

## 2. Agent Enrollment Workflow

Field officer / agent does:

1. log in
2. enter farmer details
3. capture GPS
4. create enrollment session
5. capture 5 muzzle images
6. capture 3 face images
7. capture left side, right side, back, udder
8. finish enrollment

## 3. Muzzle Capture Workflow

This is the most important flow.

### What happens for each muzzle capture

1. agent opens camera
2. live video starts
3. frontend sends frame to backend
4. backend runs YOLO on the frame
5. if muzzle is detected:
   - backend crops muzzle
   - CLAHE is applied
   - processed muzzle is saved
6. frontend receives detection confidence and crop result
7. UI increments muzzle count

### Why 5 muzzle images

The system needs 5 muzzle images for a more stable average embedding.  
This reduces the chance of one bad frame affecting matching.

## 4. Same Cattle Re-Enrollment Workflow

Business need:

The same cattle may be registered again after 2 days or later.

Expected behavior:

- if likely same cattle, data should go into the same cattle folder
- if not matched well enough, create a new cattle ID/folder

### Current decision logic

The app uses:

1. farmer name
2. nearby GPS radius
3. DINOv2 muzzle embedding confidence

If confidence is strong enough, same cattle can reuse the existing cattle folder.

## 5. Admin Review Workflow

When a match is not strong enough or is near threshold:

1. backend stores a match audit record
2. admin opens review screen
3. admin sees:
   - final cattle ID
   - confidence
   - top matches
   - captured images
4. admin confirms or corrects the result

## 6. Search Workflow

Planned/partially implemented flow:

1. agent captures 5 muzzle images for search
2. backend preprocesses all 5
3. average embedding is created
4. Pinecone is queried
5. backend returns top 5
6. app displays candidate cattle
7. admin or user can inspect top results

## 7. Image Rules

Per cattle:

- muzzle: 5
- face: 3
- left side: 1
- right side: 1
- back: 1
- udder: 1

Total:

- 12 images per cattle

Resize rule:

- if image is larger than 1024 x 768, resize before storage
