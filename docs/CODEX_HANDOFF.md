# Codex Project Handoff

Use this document when continuing Vacapay Muzzle from a different Codex or
ChatGPT account. It contains the useful project context without copying the old
conversation, credentials, or private model binaries.

## Continue In A New Codex Account

1. Sign in to Codex with the new account.
2. Open the existing repository at `E:\vacapay` or clone the GitHub repository.
3. Read these files in order:
   - `README.md`
   - `docs/CODEX_HANDOFF.md`
   - `docs/APP_ARCHITECTURE_AND_METRICS.md`
   - `docs/FIELD_APP_FULL_WORKFLOW.md`
   - `docs/COLLEAGUE_SETUP.md`
   - `docs/PRODUCTION_DEPLOYMENT.md`
4. Ask Codex to inspect `git status`, the latest commits, and the current source
   before editing anything.

Use this first prompt:

```text
Continue the Vacapay Muzzle project from this repository.

Read README.md and every file under docs/, starting with
docs/CODEX_HANDOFF.md. Inspect git status and the latest commits before making
changes. Preserve existing uncommitted work. Never expose credentials or model
binaries. Verify changes with the backend syntax check, frontend production
build, and Android sync/build when relevant.
```

## Current Repository

```text
Local path: E:\vacapay
Remote: https://github.com/karthi251104/vacapay_muzzle-.git
Branch: main
Documentation baseline commit: 40f5416
```

Always treat the working tree as authoritative. Other developers may have
pushed commits or left local changes after this document was written.

## Product Purpose

Vacapay Muzzle is a field-testing system for identifying cattle from muzzle
patterns. It has two separate workflows:

```text
Cattle Enrolment -> creates one registered identity for a cow
Cattle Search    -> tests a captured cow against registered identities
```

Business rules:

- Enrol each cow only once.
- Photographing the same cow again must use Cattle Search.
- Cattle Search never creates a registered cow automatically.
- Field officers may access only their own farmers and cattle.
- Administrators can review all officers, enrolments, searches, candidates,
  images, and accuracy results.
- Admin review supplies field-test ground truth. A duplicate warning alone does
  not make a result incorrect.

## Main Architecture

```text
Capacitor Android field app
  -> local IndexedDB capture queue
  -> backend upload API
  -> YOLO muzzle quality/crop gate
  -> DINOv2 embedding generation
  -> Pinecone registered-cattle search
  -> MongoDB metadata and Cloudinary images
  -> Angular admin review dashboard
```

Each record contains three muzzle photos and seven supporting photos. The three
muzzle embeddings are averaged and L2-normalized before storage or search. See
`docs/APP_ARCHITECTURE_AND_METRICS.md` for the complete diagram, thresholds,
Top-K logic, and metric formulas.

## Model Inventory And Security

The repository currently uses these model artifacts:

| Model | Purpose | Current Git state | Security consequence |
|---|---|---|---|
| `backend/yolo26s.pt` | Online YOLO good/bad/wet muzzle detection and crop | Tracked through Git LFS | Downloadable by anyone who can access the repository |
| `backend/dinov2_triplet_v2_best.pt` | DINOv2 cattle embedding model | Tracked through Git LFS | Downloadable by anyone who can access the repository |
| `frontend/src/assets/models/yolo26s_float32.tflite` | Offline phone muzzle gate | Tracked through Git LFS and bundled in APK | Downloadable from Git and extractable from the APK |

Important limitation:

```text
An offline model bundled inside an APK cannot be made impossible to extract.
Encryption and obfuscation only increase extraction difficulty. Absolute model
secrecy requires server-side inference and no model inside the APK.
```

Required protection before wider distribution:

1. Make the GitHub repository private and restrict collaborators.
2. Rotate any credentials previously pasted into chats, logs, commits, or
   screenshots.
3. Store model binaries in private object storage or a private model registry.
4. Inject models during backend deployment and Android release builds.
5. Remove the DINOv2 and TFLite binaries from all Git history using a coordinated
   history rewrite, then force-push and have every collaborator clone again.
6. Choose explicitly between offline TFLite inference and absolute model
   secrecy. Both cannot be guaranteed simultaneously.

The `.gitignore` blocks new model binaries, but ignore rules do not remove files
that are already tracked or present in earlier commits.

## Private Configuration

Never commit `.env` or real credentials. A new machine must privately configure:

```text
MONGODB_URI
MONGODB_DB_NAME
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
CLOUDINARY_ROOT_FOLDER
PINECONE_API_KEY
PINECONE_INDEX_HOST
PINECONE_ENROLMENT_NAMESPACE
PINECONE_SEARCH_NAMESPACE
JWT_SECRET
PYTHON_BIN
YOLO_MUZZLE_MODEL_PATH
DINOV2_MODEL_PATH
```

Use `.env.example` only as a list of variable names and safe placeholders.

## Common Commands

From PowerShell, use `.cmd` executables when script execution policy blocks
`npm.ps1` or `npx.ps1`.

```powershell
cd E:\vacapay
corepack.cmd enable
pnpm.cmd --dir backend install
pnpm.cmd --dir frontend install
pnpm.cmd --dir backend start
```

Build the frontend:

```powershell
pnpm.cmd --dir frontend run build
```

Build and synchronize the field app after setting its backend URL:

```powershell
$env:VACAPAY_API_BASE_URL="https://YOUR-BACKEND/api"
pnpm.cmd --dir frontend run build:field
npx.cmd --prefix frontend cap sync android
```

Start a temporary HTTPS tunnel after the backend is running:

```powershell
cloudflared tunnel --url http://localhost:3000
```

## Verification Before Shipping

Run checks proportional to the change:

```powershell
node --check backend\src\server.js
pnpm.cmd --dir frontend run build
npx.cmd --prefix frontend cap sync android
```

For a field release, also test:

- two different field-officer accounts and ownership isolation;
- new farmer plus first cow;
- another cow under an existing farmer;
- cattle search with and without a selected farmer;
- GPS and name/ID farmer search;
- three good muzzle captures and rejection of bad/blurred captures;
- offline capture followed by online upload retry;
- no duplicate farmer or cattle creation after retry;
- admin Top-5/Top-20 evidence and all four review outcomes;
- metrics updating only after valid admin ground truth.

## Known Production Risks

- The DINOv2 checkpoint is large and can exceed low-memory hosting limits.
- Quick Cloudflare tunnel URLs expire when the local tunnel process stops.
- A local Windows application-control policy can block PyTorch DLL loading.
- Offline queues require idempotent server APIs to prevent duplicate records.
- A public repository or distributed APK exposes any bundled model artifact.
- Existing Git history remains sensitive until it is rewritten and force-pushed.

## Do Not Do Automatically

- Do not delete field-test data unless the user explicitly requests a fresh
  reset and the exact target stores are verified.
- Do not rewrite Git history or force-push without repository-owner approval.
- Do not replace the DINOv2 or YOLO model without recording the model version and
  validating thresholds again.
- Do not trust officer IDs or names supplied by the frontend; derive ownership
  from the authenticated token on the backend.
- Do not count enrolment duplicate warnings as cattle-search accuracy records.

## Current Documentation Map

- `README.md`: entry point and common workflows.
- `docs/CODEX_HANDOFF.md`: account-to-account continuation and security state.
- `docs/APP_ARCHITECTURE_AND_METRICS.md`: architecture, models, scores, matching,
  Top-K ranking, and field metrics.
- `docs/FIELD_APP_FULL_WORKFLOW.md`: complete field-officer workflow.
- `docs/COLLEAGUE_SETUP.md`: clean-machine setup, APK build, tunnel, and Git use.
- `docs/PRODUCTION_DEPLOYMENT.md`: deployment requirements and production risks.
