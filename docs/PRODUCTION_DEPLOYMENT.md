# Production Deployment

## Runtime Separation

The browser deployment is the Vacapay Admin website. Field officer accounts use the Android application. Both surfaces call the same backend API and keep these workflows separate:

- `cattle_enrolment`: creates a registered cattle identity and enrolment Pinecone vector.
- `cattle_search`: creates search evidence, queries registered cattle and writes only to the search namespace.

## Admin Review

For every cattle search, the admin website shows:

1. Query muzzle, face, side, back and udder images.
2. The application result: Cattle Found or No Cattle Found.
3. Top-5 candidate cattle with confidence, muzzle images and supporting body images.
4. The complete Top-20 ranked cattle list.
5. Actions to confirm the same cow, mark a different cow, confirm a new cow or identify an existing cow.

Admin confirmation is ground truth. Top-1 and Top-5 accuracy are calculated only from reviewed cattle searches.

## Container Backend (Render or Railway)

Railway uses `railway.json` and the root `Dockerfile`. The image contains:

- Angular admin build.
- Node/Express API.
- CPU-only PyTorch and torchvision.
- Pillow and NumPy for DINOv2 image preparation.
- `dinov2_triplet_v2_best.pt`.
- A preloaded DINOv2 backbone cache.

The backend intentionally contains no YOLO model. Android `best.tflite` performs the good/bad decision, crop and CLAHE before upload. The API rejects muzzle files that are not marked as phone processed.

Create a Railway service from the GitHub repository and set these variables:

```text
JWT_SECRET=<at-least-32-random-characters>
REQUIRE_PRODUCTION_SERVICES=true
MONGODB_URI=<mongodb-atlas-uri>
MONGODB_DB_NAME=vacapay
CLOUDINARY_CLOUD_NAME=<cloud-name>
CLOUDINARY_API_KEY=<api-key>
CLOUDINARY_API_SECRET=<api-secret>
CLOUDINARY_ROOT_FOLDER=vacapay
PINECONE_API_KEY=<api-key>
PINECONE_INDEX_HOST=<index-host>
PINECONE_NAMESPACE=vacapay
PINECONE_ENROLMENT_NAMESPACE=vacapay-cattle-enrolment
PINECONE_SEARCH_NAMESPACE=vacapay-cattle-search
EMBEDDING_MATCH_THRESHOLD=0.70
CORS_ORIGINS=https://<railway-domain>,capacitor://localhost,http://localhost
```

Railway must pass `/api/health`. Production startup intentionally fails when a required service, secret or model file is missing.

Use a Railway service with at least 4 GB RAM and 2 vCPU for CPU PyTorch, DINOv2 and concurrent image processing. Smaller instances may be terminated while loading the model.

MongoDB is the permanent metadata store, Cloudinary is the permanent image store and Pinecone is the vector store. Railway local disk is temporary processing space only.

## Android API Configuration

The frontend reads `frontend/src/assets/runtime-config.js` before Angular starts. The admin website uses same-origin defaults:

```js
window.VACAPAY_CONFIG = {
  apiBaseUrl: '/api',
  mediaBaseUrl: ''
};
```

For the Android package, set both values to the Railway backend before building:

```js
window.VACAPAY_CONFIG = {
  apiBaseUrl: 'https://<railway-domain>/api',
  mediaBaseUrl: 'https://<railway-domain>'
};
```

The Android application must bundle `best.tflite`, keep unsynced images in app-private storage, and upload records using stable `offlineCaptureId` values.

## Netlify Admin Website

Netlify uses `netlify.toml` and publishes only `frontend/dist/vacapay/browser`. Add this environment variable before deploying:

```text
VACAPAY_API_BASE_URL=https://<railway-domain>/api
```

Optionally set `VACAPAY_MEDIA_BASE_URL=https://<railway-domain>`. Add the final Netlify origin to Railway `CORS_ORIGINS`, for example:

```text
CORS_ORIGINS=https://<site-name>.netlify.app,capacitor://localhost,http://localhost
```

Netlify builds the admin-only production target. It does not upload `best.tflite` or the TFLite WASM runtime.

## Android Scaffold

The Capacitor Android project is in `frontend/android` with package ID `com.vacapay.muzzlefield`. It requires Java and Android Studio/SDK 36 on the build machine.

Build and synchronize it after setting the Railway API URL:

```powershell
$env:VACAPAY_API_BASE_URL="https://<railway-domain>/api"
pnpm --dir frontend run android:sync
pnpm --dir frontend run android:open
```

The field build includes the local TFLite model and WASM runtime. Camera, network and location permissions are declared in the Android manifest. A signed release APK still requires an Android release keystore.

## Release Verification

Before field release, verify:

1. Admin accounts can sign in on the website and field accounts are rejected there.
2. The admin can expand a search and inspect query, Top-5 and Top-20 evidence without horizontal overflow.
3. A three-muzzle enrolment produces an embedding and enrolment Pinecone vector.
4. A cattle search never creates a registered cattle identity.
5. Interrupted uploads resume without duplicate cattle or duplicate search records.
6. Cloudinary images remain visible after a Railway restart.
7. MongoDB and Pinecone records remain available after a Railway restart.
8. Missing production variables cause startup to fail with a clear error.
