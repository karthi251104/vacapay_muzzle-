"""
================================================================================
VACAPAY MLOPS: MLflow Model Registry & Champion vs Challenger Promotion
================================================================================
Purpose:
    1. Registers trained candidate models into the MLflow Model Registry.
    2. Compares the new candidate model against the current 'Production' model.
    3. Promotes candidate to 'Production' if its mAP@50 score beats the champion.
    4. Handles model versioning, lineage, and metadata tags for audits.
================================================================================
"""

import os
import logging
from mlflow.tracking import MlflowClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("VacaPay-ModelRegistry")

class MuzzleModelRegistry:
    def __init__(
        self,
        model_name: str = "Vacapay-Muzzle-Detector",
        tracking_uri: str = None
    ):
        self.model_name = model_name
        self.tracking_uri = tracking_uri or os.getenv("MLFLOW_TRACKING_URI", "sqlite:///mlflow.db")
        self.client = MlflowClient(tracking_uri=self.tracking_uri)

    def register_candidate_model(self, run_id: str, artifact_subpath: str = "weights/best.pt") -> int:
        """
        Creates a registered model version from an MLflow run artifact.
        """
        model_source = f"runs:/{run_id}/{artifact_subpath}"
        logger.info(f"Registering new model version for '{self.model_name}' from {model_source}...")

        # Ensure registered model container exists
        try:
            self.client.create_registered_model(
                name=self.model_name,
                description="Production YOLOv8 biometric cattle muzzle detector and quality classifier."
            )
            logger.info(f"Created registered model collection '{self.model_name}'.")
        except Exception:
            # Model container already exists
            pass

        # Create new version
        model_version = self.client.create_model_version(
            name=self.model_name,
            source=model_source,
            run_id=run_id,
            description=f"Candidate model trained in run {run_id}"
        )

        logger.info(f"Successfully registered model '{self.model_name}' Version {model_version.version}")
        return int(model_version.version)

    def evaluate_and_promote(
        self,
        candidate_run_id: str,
        candidate_version: int,
        primary_metric: str = "mAP_50",
        min_threshold: float = 0.70
    ) -> bool:
        """
        Champion vs Challenger Logic:
        1. Checks current Production model's score.
        2. Compares with candidate's score.
        3. If candidate is superior and passes min_threshold, promote to 'Production'.
        """
        # Fetch candidate run metrics
        candidate_run = self.client.get_run(candidate_run_id)
        candidate_score = candidate_run.data.metrics.get(primary_metric, 0.0)
        logger.info(f"Candidate (v{candidate_version}) {primary_metric}: {candidate_score:.4f}")

        if candidate_score < min_threshold:
            logger.warning(f"Candidate rejected: {primary_metric} ({candidate_score:.4f}) is below minimum threshold ({min_threshold}).")
            self.client.set_model_version_tag(
                name=self.model_name,
                version=str(candidate_version),
                key="validation_status",
                value="REJECTED_BELOW_THRESHOLD"
            )
            return False

        # Look for existing production version
        current_prod_version = None
        current_prod_score = 0.0

        for mv in self.client.search_model_versions(f"name='{self.model_name}'"):
            if mv.current_stage == "Production":
                current_prod_version = mv.version
                prod_run = self.client.get_run(mv.run_id)
                current_prod_score = prod_run.data.metrics.get(primary_metric, 0.0)
                break

        if current_prod_version is None:
            logger.info(f"No existing Production model found. Auto-promoting v{candidate_version} to Production!")
            self._promote_to_production(candidate_version)
            return True

        logger.info(f"Current Production (v{current_prod_version}) {primary_metric}: {current_prod_score:.4f}")

        # Comparison
        if candidate_score > current_prod_score:
            margin = candidate_score - current_prod_score
            logger.info(f"New Champion! Candidate v{candidate_version} outperforms Production v{current_prod_version} by +{margin:.4f}.")
            
            # Archive old production model
            self.client.transition_model_version_stage(
                name=self.model_name,
                version=str(current_prod_version),
                stage="Archived",
                archive_existing_versions=False
            )
            # Promote new candidate
            self._promote_to_production(candidate_version)
            return True
        else:
            logger.info(f"Candidate v{candidate_version} did not outperform Production v{current_prod_version}. Keeping current champion.")
            self.client.transition_model_version_stage(
                name=self.model_name,
                version=str(candidate_version),
                stage="Staging"
            )
            return False

    def _promote_to_production(self, version: int):
        self.client.transition_model_version_stage(
            name=self.model_name,
            version=str(version),
            stage="Production",
            archive_existing_versions=True
        )
        self.client.set_model_version_tag(
            name=self.model_name,
            version=str(version),
            key="deployment_status",
            value="ACTIVE_PRODUCTION"
        )
        logger.info(f"Model '{self.model_name}' Version {version} is now LIVE in PRODUCTION!")

if __name__ == "__main__":
    registry = MuzzleModelRegistry()
    print("Muzzle Model Registry ready.")
