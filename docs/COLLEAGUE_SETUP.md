# Vacapay Complete Windows Setup And Handoff

This guide takes a new developer from an empty Windows machine to a working
Vacapay backend, admin web app, Android field app, APK, Cloudflare test link,
and Git contribution workflow.

The repository is:

```text
https://github.com/karthi251104/vacapay_muzzle-.git
```

## 1. What Runs Where

```text
frontend/
  Angular admin UI
  Capacitor Android field app
  best.tflite phone muzzle detector

backend/
  Express API
  DINOv2 embedding process
  MongoDB, Cloudinary and Pinecone integration
  dinov2_triplet_v2_best.pt checkpoint

data/
  local runtime files only; never commit this folder
```

The official field workflows are separate:

```text
Cattle Enrolment -> creates a registered cattle identity and enrolment vector
Cattle Search    -> creates search evidence and checks registered cattle
```

## 2. Machine Requirements

Use a 64-bit Windows 10 or Windows 11 computer.

Required software:

| Dependency | Recommended version | Purpose |
| --- | --- | --- |
| Git for Windows | Current | Clone, commit and push |
| Git LFS | Current | Download the 353 MB DINOv2 checkpoint |
| Node.js | 24.x | Angular and Express |
| pnpm | 10.12.1 | JavaScript dependencies and scripts |
| Python | 3.11 x64 | DINOv2 inference and OpenCV |
| Microsoft Visual C++ Redistributable | 2015-2022 x64 | PyTorch native DLLs on Windows |
| Android Studio | Current stable | Android SDK, JDK, emulator and APK tools |
| Android SDK Platform | API 36 | Project compile/target SDK |
| Cloudflared | Current | Temporary HTTPS access from field phones |

Recommended hardware for local DINOv2 inference:

```text
RAM: 8 GB minimum, 16 GB preferred
Free disk: at least 8 GB
Internet: required for installation, external services and first DINOv2 load
```

The DINOv2 backend is not suitable for a 512 MB free hosting instance. It can
run out of memory while loading PyTorch and the model.

### Install With Winget

Open PowerShell as Administrator:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.GitLFS -e
winget install --id OpenJS.NodeJS -e
winget install --id Python.Python.3.11 -e
winget install --id Microsoft.VCRedist.2015+.x64 -e
winget install --id Google.AndroidStudio -e
winget install --id Cloudflare.cloudflared -e
```

Close and reopen PowerShell after installation.

## 3. Clone The Repository And Download Models

Choose a short path without unusual characters. Example:

```powershell
cd E:\
git lfs install
git clone https://github.com/karthi251104/vacapay_muzzle-.git vacapay
cd E:\vacapay
git lfs pull
```

Verify both models:

```powershell
Get-Item backend\dinov2_triplet_v2_best.pt
Get-Item backend\best.pt
Get-Item frontend\src\assets\models\best.tflite
```

Expected approximate sizes:

```text
backend/dinov2_triplet_v2_best.pt       353 MB
frontend/src/assets/models/best.tflite   80 MB
backend/best.pt                          backend YOLO PT model
```

If the `.pt` file is only a few bytes or contains text beginning with
`version https://git-lfs.github.com`, run `git lfs pull` again.

## 4. Install Node And pnpm Dependencies

Check Node:

```powershell
node --version
npm --version
```

Enable pnpm:

```powershell
corepack enable
corepack prepare pnpm@10.12.1 --activate
pnpm --version
```

If `corepack` is unavailable:

```powershell
npm install --global pnpm@10.12.1
pnpm --version
```

Install repository dependencies:

```powershell
cd E:\vacapay
pnpm install
pnpm run install:all
```

The explicit alternative is:

```powershell
pnpm --dir backend install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
```

Do not delete or regenerate lockfiles unless dependencies are intentionally
being changed.

## 5. Create The Python Environment

Create the virtual environment at repository root. The backend automatically
detects `.venv\Scripts\python.exe`.

```powershell
cd E:\vacapay
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
.\.venv\Scripts\python.exe -m pip install numpy opencv-python-headless pillow
```

Verify imports:

```powershell
.\.venv\Scripts\python.exe -c "import torch, cv2, numpy, PIL; print(torch.__version__); print(cv2.__version__)"
```

The first embedding request can be slower because Torch Hub prepares the
DINOv2 architecture. Keep internet available for the first run.

## 6. Configure Private Environment Variables

The backend reads **the root file** `E:\vacapay\.env`. It does not read
`backend\.env`.

Create it from the template:

```powershell
cd E:\vacapay
Copy-Item .env.example .env
notepad .env
```

Fill these values with credentials supplied privately by the project owner:

```dotenv
PORT=3000
MONGODB_URI=...
MONGODB_DB_NAME=vacapay
JWT_SECRET=use_at_least_32_random_characters
REQUIRE_PRODUCTION_SERVICES=true
CORS_ORIGINS=https://your-admin-domain.netlify.app,https://localhost,capacitor://localhost,http://localhost

CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_ROOT_FOLDER=vacapay

PINECONE_API_KEY=...
PINECONE_INDEX_HOST=https://your-index-host.svc.aped-4627-b74a.pinecone.io
PINECONE_NAMESPACE=vacapay

EMBEDDING_MATCH_THRESHOLD=0.70
MUZZLE_IMAGE_COUNT=3
YOLO_IMGSZ=640
MUZZLE_CONF=0.55
```

Optional explicit Windows paths:

```dotenv
PYTHON_BIN=E:\vacapay\.venv\Scripts\python.exe
DINOV2_MODEL_PATH=E:\vacapay\backend\dinov2_triplet_v2_best.pt
YOLO_MUZZLE_MODEL_PATH=E:\vacapay\backend\best.pt
```

Rules:

```text
Never commit .env.
Never paste credentials in README, source code, screenshots or chat groups.
Do not share one developer's JWT secret publicly.
Use the same production service credentials only with project-owner approval.
```

Generate a JWT secret in PowerShell:

```powershell
([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
```

## 7. Run Locally

### Option A: Admin And API On One URL

Build the frontend, then start the backend:

```powershell
cd E:\vacapay
pnpm --dir frontend run build
pnpm --dir backend start
```

Open:

```text
http://localhost:3000
http://localhost:3000/api/health
http://localhost:3000/api/version
```

Leave that PowerShell window open.

### Option B: Angular Development Server

Terminal 1:

```powershell
cd E:\vacapay
pnpm --dir backend start
```

Terminal 2:

```powershell
cd E:\vacapay
pnpm --dir frontend start
```

Open `http://localhost:4200`. The Angular proxy forwards `/api` calls to the
backend on port 3000.

### Health Verification

```powershell
Invoke-RestMethod http://localhost:3000/api/health | ConvertTo-Json -Depth 6
Invoke-RestMethod http://localhost:3000/api/version | ConvertTo-Json -Depth 6
```

Check that health reports:

```text
ok: true
Python runtime points to .venv
DINOv2 model path exists
MongoDB enabled
Cloudinary enabled
Pinecone enabled
three muzzle images
separate cattle-enrolment and cattle-search namespaces
```

## 8. Create A Cloudflare Phone-Test Link

The backend must already be running on port 3000.

Open another PowerShell window:

```powershell
cloudflared tunnel --protocol http2 --url http://localhost:3000 --no-autoupdate
```

Cloudflared prints a URL similar to:

```text
https://random-words.trycloudflare.com
```

Test it before building the APK:

```powershell
Invoke-RestMethod https://random-words.trycloudflare.com/api/health
```

Important quick-tunnel behavior:

```text
The link works only while the backend PC and cloudflared window remain on.
Every restarted quick tunnel normally gets a different URL.
An APK built with an old quick-tunnel URL needs to be rebuilt.
Error 1033 means the old tunnel process stopped or expired.
Use a named Cloudflare tunnel or stable hosted backend for real deployment.
```

## 9. Install Android Studio Requirements

Open Android Studio and install from SDK Manager:

```text
Android SDK Platform 36
Android SDK Build-Tools
Android SDK Platform-Tools
Android SDK Command-line Tools
Android Emulator (only when an emulator is required)
```

The project uses:

```text
Application ID: com.vacapay.muzzlefield
Minimum Android: API 24
Compile SDK: API 36
Target SDK: API 36
JDK: Android Studio bundled JBR
```

Create `frontend\android\local.properties` if Android Studio did not create it:

```properties
sdk.dir=C\:\\Users\\YOUR_WINDOWS_USER\\AppData\\Local\\Android\\Sdk
```

Do not copy another developer's `local.properties`; its Windows user path is
machine-specific.

## 10. Build A Field APK

Start the backend and Cloudflare first. Then use the current tunnel URL in the
same PowerShell window that runs the frontend build:

```powershell
cd E:\vacapay
$env:VACAPAY_API_BASE_URL="https://random-words.trycloudflare.com/api"
$env:VACAPAY_MEDIA_BASE_URL="https://random-words.trycloudflare.com"
pnpm --dir frontend run build:field
pnpm --dir frontend exec cap sync android
```

Build the testing APK with Android Studio's JDK:

```powershell
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
cd E:\vacapay\frontend\android
.\gradlew.bat assembleDebug
```

APK output:

```text
E:\vacapay\frontend\android\app\build\outputs\apk\debug\app-debug.apk
```

Copy and name it clearly:

```powershell
New-Item -ItemType Directory -Force E:\vacapay\builds | Out-Null
Copy-Item E:\vacapay\frontend\android\app\build\outputs\apk\debug\app-debug.apk E:\vacapay\builds\Vacapay-Field-Test.apk -Force
```

Verify the API URL embedded in the Android assets:

```powershell
Get-Content E:\vacapay\frontend\android\app\src\main\assets\public\assets\runtime-config.js
```

It must show the current Cloudflare or production backend URL.

### Build From Android Studio

```powershell
cd E:\vacapay
pnpm --dir frontend exec cap open android
```

In Android Studio:

```text
Wait for Gradle sync.
Select Build > Build APK(s) for an internal test APK.
Select Build > Generate Signed App Bundle or APK for a signed release APK.
```

Never publish a debug APK as a permanent production release. Store the release
keystore and passwords securely outside Git. Losing the keystore prevents
future upgrades of the same installed application.

## 11. Install And Test The APK

Enable USB debugging on the phone, connect it, and run:

```powershell
$adb="$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb install -r E:\vacapay\builds\Vacapay-Field-Test.apk
```

On the phone, verify this complete flow:

```text
1. Sign in as a field officer.
2. Update Farmer Data while online.
3. Add a new farmer and enrol one cow.
4. Add a second cow under the same farmer; it must become Cattle 2.
5. Confirm both cows have the same farmer ID.
6. Run Cattle Search for an enrolled cow.
7. Run Cattle Search for a new cow and expect No Cattle Found.
8. Turn internet off, complete a capture and confirm Waiting Upload increases.
9. Restore internet and upload the pending record.
10. Open admin and review Top-5/Top-20 evidence.
11. Mark the result correct or incorrect.
12. Confirm reviewed/highlighted status appears in the field list.
13. Test visible Back and Android hardware Back on every capture screen.
```

Do not enrol the same cow again for testing. Use **Cattle Search** for every
later check of an already enrolled cow.

## 12. Admin Web Build And Netlify

Set this Netlify environment variable:

```text
VACAPAY_API_BASE_URL=https://YOUR-STABLE-BACKEND.example.com/api
```

For a manual local build:

```powershell
cd E:\vacapay
$env:VACAPAY_API_BASE_URL="https://YOUR-STABLE-BACKEND.example.com/api"
$env:VACAPAY_MEDIA_BASE_URL="https://YOUR-STABLE-BACKEND.example.com"
pnpm --dir frontend run build:netlify
```

Publish directory:

```text
frontend/dist/vacapay/browser
```

The backend root `.env` must allow the exact admin origin without a trailing
slash, for example:

```dotenv
CORS_ORIGINS=https://vacapayadmin.netlify.app,https://localhost,capacitor://localhost,http://localhost
```

Redeploy the backend after changing CORS variables.

## 13. Docker Alternative

Docker is useful when Python and Node should be isolated. Docker Desktop must
be installed and running.

```powershell
cd E:\vacapay
Copy-Item .env.example .env
# Fill .env first.
docker compose up --build
```

Open `http://localhost:3000/api/health`.

The first Docker build is large and needs internet because it installs CPU
PyTorch and prepares the DINOv2 Torch Hub source. Local Windows setup is often
faster for a short field test.

## 14. Git Work And Push Commands

### Start Work Safely

```powershell
cd E:\vacapay
git switch main
git pull --rebase origin main
git status
git switch -c feature/short-description
```

Make the change, then verify it:

```powershell
pnpm --dir frontend run build
node --check backend/src/server.js
git diff --check
git status
git diff
```

Commit only intended files:

```powershell
git add README.md docs/COLLEAGUE_SETUP.md
git commit -m "Document complete developer setup"
git push -u origin feature/short-description
```

Open a pull request and merge it after review.

### If The Team Pushes Directly To main

Use this only when the project owner allows it:

```powershell
git switch main
git pull --rebase origin main
git add path/to/file1 path/to/file2
git commit -m "Describe the change clearly"
git push origin main
```

Never use `git push --force` on `main`. Never commit `.env`, API keys, database
credentials, `data/`, `.venv/`, `builds/`, logs, or machine-specific files.

### When A Rebase Is Already In Progress

```powershell
git status
git rebase --continue
```

Resolve any listed conflict, `git add` the resolved file, and run
`git rebase --continue` again. Do not start a second rebase while one is active.

## 15. Required Verification Before Every Push

```powershell
cd E:\vacapay
pnpm --dir frontend run build
node --check backend/src/server.js
git diff --check
git status
```

For Android changes also run:

```powershell
pnpm --dir frontend exec cap sync android
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
cd E:\vacapay\frontend\android
.\gradlew.bat assembleDebug
```

For backend matching changes, verify:

```text
/api/health
/api/version
cattle enrolment completion
cattle search completion
Top-5/Top-20 admin evidence
admin review decision
offline upload retry
```

## 16. Common Problems

### `pnpm` Is Not Recognized

```powershell
corepack enable
corepack prepare pnpm@10.12.1 --activate
```

Fallback:

```powershell
npm install --global pnpm@10.12.1
```

### `cloudflared` Is Not Recognized

Reopen PowerShell after installation, or use:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --protocol http2 --url http://localhost:3000 --no-autoupdate
```

### `ModuleNotFoundError: No module named cv2`

```powershell
.\.venv\Scripts\python.exe -m pip install opencv-python-headless
```

Confirm `.env` points to the same `.venv` when `PYTHON_BIN` is set.

### PyTorch `c10.dll` Or WinError 126

Install Microsoft Visual C++ 2015-2022 Redistributable x64, reboot if needed,
then verify `import torch` in the project virtual environment.

### PyTorch WinError 4551 Or Application Control Block

This means Windows App Control, WDAC, Smart App Control or an organisation
security policy blocked a PyTorch DLL such as `torch_python.dll`. Reinstalling
the model does not fix a policy block. Use a developer machine where approved
Python/PyTorch binaries are allowed, or ask the system administrator to approve
the project virtual environment. Do not disable organisation security controls
without authorisation.

### DINOv2 Model Is Missing After Clone

```powershell
git lfs install
git lfs pull
```

### Android SDK Not Found

Open Android Studio once and install SDK 36. Then correct
`frontend\android\local.properties` for the current Windows user.

### APK Shows An Old Server Error

The backend URL is compiled into `runtime-config.js`. Set the new URL, run
`build:field`, run `cap sync android`, and rebuild the APK. Reinstall it with
`adb install -r`.

### Cloudflare Error 1033

The quick tunnel stopped. Start a new tunnel, verify `/api/health`, and rebuild
the field APK with the new URL.

### White Page

Check these in order:

```text
backend /api/health returns 200
tunnel root returns the Angular index page
runtime-config.js contains the correct API URL
the APK was rebuilt after cap sync
Chrome/Android WebView is current
backend and tunnel terminals remain open
```

### `409 Enrollment Is Incomplete` Or Missing Muzzle Images

Confirm three accepted muzzle crops and seven supporting images are present.
Do not close the app during upload. Check backend logs and verify the phone is
using the latest APK and current backend URL.

### Backend Runs Out Of Memory

Run DINOv2 on a machine or hosting plan with enough RAM. A 512 MB free service
is not enough. The local PC plus Cloudflare tunnel is acceptable for a short
controlled field test, but the PC must remain powered on.

## 17. Fresh Test Data Reset

This operation is destructive. Confirm with the project owner first.

```powershell
cd E:\vacapay
pnpm --dir backend run reset:field-data
```

It clears field enrolments, searches, reviews, Cloudinary cattle images and
both Pinecone namespaces while preserving user accounts. Every field phone
should then install the APK for the new test cycle so old local queues cannot
upload into the fresh dataset.

## 18. Handoff Checklist

Before telling another developer the project works, confirm:

```text
[ ] Git LFS downloaded the full DINOv2 checkpoint
[ ] best.tflite exists in frontend assets
[ ] root .env exists but is not tracked
[ ] Node, pnpm and Python versions are correct
[ ] Python imports torch and cv2
[ ] frontend production build passes
[ ] backend syntax check passes
[ ] local /api/health returns ok=true
[ ] Cloudflare /api/health works from another device/network
[ ] field build contains the current backend URL
[ ] Capacitor sync completes
[ ] APK assembles successfully
[ ] APK installs and signs in on a real phone
[ ] enrolment, cattle search, offline upload and admin review are tested
[ ] git status contains no credentials, models generated by mistake or logs
```
