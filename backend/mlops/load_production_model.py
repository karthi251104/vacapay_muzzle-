"""
================================================================================
VACAPAY MLOPS: Dynamic Production Model Loader (Zero Docker Rebuilds)
================================================================================
Purpose:
    1. Used by the inference server (FastAPI, Flask, or Node.js worker) on boot.
    2. Queries MLflow / AWS S3 for the current 'Production' model version.
    3. Downloads and caches weights locally to '/app/models/champion_muzzle.pt'.
    4. Enables instant zero-rebuild updates: retrain in MLflow -> promote ->
       production containers automatically load the new champion weights.
    5. Includes fallback to local default if cloud is offline.
================================================================================
"""

import os
import shutil
import logging
from pathlib import Path
import mlflow
from mlflow.tracking import MlflowClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("VacaPay-ModelLoader")

def load_champion_model(
    model_name: str = "Vacapay-Muzzle-Detector",
    stage: str = "Production",
    local_cache_dir: str = "models",
    fallback_local_weights: str = "backend/best.pt",
    tracking_uri: str = None
) -> Path:
    """
    Downloads and returns the local Path to the current Production model weights.
    """
    target_cache_dir = Path(local_cache_dir)
    target_cache_dir.mkdir(parents=True, exist_ok=True)
    destination_weights = target_cache_dir / "champion_muzzle.pt"

    tracking_uri = tracking_uri or os.getenv("MLFLOW_TRACKING_URI", "sqlite:///mlflow.db")
    
    try:
        logger.info(f"Connecting to MLflow Tracking Server: {tracking_uri}")
        client = MlflowClient(tracking_uri=tracking_uri)
        
        # 1. Query for the model version in 'Production'
        prod_versions = [
            mv for mv in client.search_model_versions(f"name='{model_name}'")
            if mv.current_stage == stage
        ]

        if not prod_versions:
            logger.warning(f"No model found in '{stage}' stage for '{model_name}'. Checking fallback...")
            return _handle_fallback(destination_weights, fallback_local_weights)

        latest_prod = prod_versions[0]
        version = latest_prod.version
        run_id = latest_prod.run_id
        logger.info(f"Found active {stage} Model: Version {version} (Trained in Run ID: {run_id})")

        # 2. Download artifact from S3 / MLflow store
        # Download the specific best.pt file
        downloaded_path = client.download_artifacts(run_id=run_id, path="weights/best.pt", dst_path=str(target_cache_dir))
        logger.info(f"Downloaded weights to: {downloaded_path}")

        # Ensure named as champion_muzzle.pt
        shutil.copy2(downloaded_path, destination_weights)
        logger.info(f"Production champion weights ready at: {destination_weights.resolve()}")
        return destination_weights

    except Exception as e:
        logger.warning(f"Could not fetch model from MLflow ({e}). Falling back to local default.")
        return _handle_fallback(destination_weights, fallback_local_weights)

def _handle_fallback(destination_path: Path, fallback_path_str: str) -> Path:
    fallback = Path(fallback_path_str)
    if fallback.exists():
        logger.info(f"Using local fallback model weights: {fallback.resolve()}")
        if not destination_path.exists():
            shutil.copy2(fallback, destination_path)
        return fallback
    elif destination_path.exists():
        logger.info(f"Using existing cached model weights: {destination_path.resolve()}")
        return destination_path
    else:
        raise FileNotFoundError(f"Neither MLflow model nor local fallback weights found at {fallback}")

if __name__ == "__main__":
    weights_path = load_champion_model()
    print(f"Loaded weights path: {weights_path}")
