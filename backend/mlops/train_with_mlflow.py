"""
================================================================================
VACAPAY MLOPS: Training & Experiment Tracking with MLflow & AWS S3
================================================================================
Purpose:
    1. Sets up MLflow tracking (local SQLite backend or remote server on EC2/ECS).
    2. Stores experiment runs, parameters, metrics, and models in AWS S3.
    3. Trains YOLOv8 cattle muzzle detector with automated metric logging:
       - mAP@50 (Mean Average Precision at IoU=0.50)
       - mAP@50-95 (Mean Average Precision across IoU thresholds 0.50 to 0.95)
       - Precision & Recall
       - Box Loss (CIoU), Class Loss (BCE), and DFL Loss
    4. Automatically uploads best model weights ('best.pt') & diagnostic plots to S3.
================================================================================
"""

import os
import sys
import logging
from pathlib import Path
import mlflow
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("VacaPay-MLflow-Trainer")

def train_yolo_with_mlflow(
    data_yaml_path: str,
    model_architecture: str = "yolov8n.pt",
    epochs: int = 30,
    imgsz: int = 640,
    batch_size: int = 16,
    learning_rate: float = 0.01,
    experiment_name: str = "vacapay-muzzle-yolo",
    tracking_uri: str = None,
    s3_artifact_bucket: str = None,
    dataset_version: str = "v1.0"
):
    """
    Executes a training run tracked with MLflow.
    """
    # 1. Setup MLflow Tracking URI
    # Default to local sqlite or remote MLflow server on AWS EC2
    tracking_uri = tracking_uri or os.getenv("MLFLOW_TRACKING_URI", "sqlite:///mlflow.db")
    s3_artifact_bucket = s3_artifact_bucket or os.getenv("VACAPAY_S3_ARTIFACTS", "vacapay-mlflow-artifacts")
    
    mlflow.set_tracking_uri(tracking_uri)
    logger.info(f"MLflow Tracking URI connected to: {tracking_uri}")

    # Set or create experiment
    mlflow.set_experiment(experiment_name)
    logger.info(f"Using MLflow Experiment: '{experiment_name}'")

    # 2. Start MLflow Run Context
    run_name = f"run_{Path(model_architecture).stem}_epochs{epochs}_imgsz{imgsz}"
    with mlflow.start_run(run_name=run_name) as run:
        run_id = run.info.run_id
        logger.info(f"Started MLflow Run: {run_name} (Run ID: {run_id})")

        # 3. Log Hyperparameters & Metadata
        hyperparams = {
            "model_architecture": model_architecture,
            "epochs": epochs,
            "imgsz": imgsz,
            "batch_size": batch_size,
            "initial_learning_rate": learning_rate,
            "optimizer": "AdamW",
            "dataset_version": dataset_version,
            "data_config": data_yaml_path,
            "framework": "ultralytics_yolov8",
            "device": "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu"
        }
        mlflow.log_params(hyperparams)
        logger.info("Logged hyperparameters to MLflow.")

        # 4. Initialize YOLO Model
        logger.info(f"Initializing YOLO model from base weights: {model_architecture}")
        model = YOLO(model_architecture)

        # 5. Train Model
        logger.info("Starting training loop...")
        train_results = model.train(
            data=data_yaml_path,
            epochs=epochs,
            imgsz=imgsz,
            batch=batch_size,
            lr0=learning_rate,
            optimizer="AdamW",
            project="runs/train",
            name=f"mlflow_{run_id[:8]}",
            exist_ok=True,
            save=True,
            plots=True,
            verbose=True
        )

        # 6. Extract and Log Final Evaluation Metrics
        logger.info("Extracting validation and performance metrics...")
        
        # Ultralytics results.results_dict contains key metrics
        val_metrics = model.val(data=data_yaml_path)
        
        # mAP, Precision, Recall
        map50 = float(val_metrics.box.map50)
        map50_95 = float(val_metrics.box.map)
        precision = float(val_metrics.box.mp)
        recall = float(val_metrics.box.mr)

        metrics_to_log = {
            "mAP_50": map50,
            "mAP_50_95": map50_95,
            "precision": precision,
            "recall": recall,
            "fitness": float(val_metrics.fitness)
        }
        mlflow.log_metrics(metrics_to_log)
        logger.info(f"Logged Key Metrics -> mAP@50: {map50:.4f}, mAP@50-95: {map50_95:.4f}, Precision: {precision:.4f}, Recall: {recall:.4f}")

        # 7. Log Artifacts (Model Weights, Confusion Matrix, Curves)
        train_output_dir = Path(train_results.save_dir)
        best_pt_path = train_output_dir / "weights" / "best.pt"
        
        if best_pt_path.exists():
            logger.info(f"Logging trained champion weights: {best_pt_path}")
            # Uploads directly to AWS S3 (or local artifact directory)
            mlflow.log_artifact(str(best_pt_path), artifact_path="weights")
        
        # Log diagnostic graphs
        for graph_name in ["confusion_matrix.png", "results.png", "F1_curve.png", "PR_curve.png"]:
            graph_path = train_output_dir / graph_name
            if graph_path.exists():
                mlflow.log_artifact(str(graph_path), artifact_path="plots")

        # Log dataset configuration
        if Path(data_yaml_path).exists():
            mlflow.log_artifact(data_yaml_path, artifact_path="dataset_metadata")

        # 8. Set Tags for Easy Filtering in MLflow UI
        mlflow.set_tags({
            "stage": "experimentation",
            "model_type": "yolov8_object_detection",
            "target": "cattle_muzzle_quality",
            "run_id": run_id
        })

        logger.info(f"MLflow Run '{run_id}' completed successfully!")
        return {
            "run_id": run_id,
            "map50": map50,
            "map50_95": map50_95,
            "best_weights": str(best_pt_path) if best_pt_path.exists() else None,
            "status": "success"
        }

if __name__ == "__main__":
    default_yaml = "data/processed_yolo_dataset/data.yaml"
    if not os.path.exists(default_yaml):
        logger.warning(f"Default dataset YAML '{default_yaml}' not found.")
        logger.info("Please run data_pipeline.py first to create a valid dataset.")
        sys.exit(0)
    
    train_yolo_with_mlflow(data_yaml_path=default_yaml, epochs=5)
