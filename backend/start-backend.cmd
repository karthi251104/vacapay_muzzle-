@echo off
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"
for %%I in ("%SCRIPT_DIR%..") do set ROOT_DIR=%%~fI
set PYTHON_BIN=%ROOT_DIR%\.venv-llm-muzzle\Scripts\python.exe
if not exist "%PYTHON_BIN%" set PYTHON_BIN=%ROOT_DIR%\.venv\Scripts\python.exe
if not exist "%PYTHON_BIN%" set PYTHON_BIN=python
set MODEL_PATH=%ROOT_DIR%\best_v4.pt
set DINOV2_MODEL_PATH=%ROOT_DIR%\backend\dinov2_triplet_v2_best.pt
set EMBEDDING_MATCH_THRESHOLD=0.70
set YOLO_CONFIG_DIR=%ROOT_DIR%\data\ultralytics
set MPLCONFIGDIR=%ROOT_DIR%\data\matplotlib
rem Optional Cloudinary storage. Set CLOUDINARY_API_SECRET in this terminal before running.
if "%CLOUDINARY_CLOUD_NAME%"=="" set CLOUDINARY_CLOUD_NAME=dcoblsomz
if "%CLOUDINARY_API_KEY%"=="" set CLOUDINARY_API_KEY=448473262611422
if "%CLOUDINARY_ROOT_FOLDER%"=="" set CLOUDINARY_ROOT_FOLDER=vacapay
rem Optional MongoDB Atlas metadata storage. Set MONGODB_URI in this terminal before running.
if "%MONGODB_DB_NAME%"=="" set MONGODB_DB_NAME=vacapay
rem Optional Pinecone vector storage. Set PINECONE_API_KEY and PINECONE_INDEX_HOST before running.
if "%PINECONE_NAMESPACE%"=="" set PINECONE_NAMESPACE=vacapay
if "%PINECONE_INDEX_HOST%"=="" set PINECONE_INDEX_HOST=https://vacapay-u1fuv30.svc.aped-4627-b74a.pinecone.io
echo Starting backend at %DATE% %TIME% >> backend.out.log
"C:\Users\dev1x\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" src\server.js >> backend.out.log 2>> backend.err.log
echo Backend exited at %DATE% %TIME% with code %ERRORLEVEL% >> backend.err.log
