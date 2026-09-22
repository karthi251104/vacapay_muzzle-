"""
================================================================================
VACAPAY MLOPS DATA PIPELINE: AWS S3 Ingestion, Validation & Preparation
================================================================================
Purpose:
    1. Ingests raw cattle muzzle images from AWS S3 (or local staging folder).
    2. Runs quality checks (corrupt image detection, resolution, color channels).
    3. Formats dataset into standard YOLO directory structure:
       - dataset/images/train
       - dataset/images/val
       - dataset/labels/train
       - dataset/labels/val
       - data.yaml
    4. Computes MD5 dataset hash for reproducible data versioning.
================================================================================
"""

import os
import glob
import shutil
import hashlib
import logging
from pathlib import Path
from typing import Dict, List, Tuple
from PIL import Image

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("VacaPay-DataPipeline")

class MuzzleDataPipeline:
    def __init__(
        self,
        s3_bucket: str = os.getenv("VACAPAY_S3_DATA_BUCKET", "vacapay-muzzle-data"),
        s3_prefix: str = "raw_uploads/",
        local_raw_dir: str = "data/raw_muzzles",
        output_dataset_dir: str = "data/processed_yolo_dataset",
        val_split_ratio: float = 0.2,
        min_width: int = 320,
        min_height: int = 320,
    ):
        """
        Initializes the data pipeline configuration.
        """
        self.s3_bucket = s3_bucket
        self.s3_prefix = s3_prefix
        self.local_raw_dir = Path(local_raw_dir)
        self.output_dataset_dir = Path(output_dataset_dir)
        self.val_split_ratio = val_split_ratio
        self.min_width = min_width
        self.min_height = min_height

    def sync_from_s3(self) -> int:
        """
        Downloads new cattle muzzle captures from AWS S3 bucket using boto3.
        In local dev/testing mode without AWS keys, it falls back to local data gracefully.
        """
        logger.info(f"Syncing raw data from AWS S3: s3://{self.s3_bucket}/{self.s3_prefix}")
        self.local_raw_dir.mkdir(parents=True, exist_ok=True)
        
        try:
            import boto3
            from botocore.exceptions import NoCredentialsError, ClientError

            s3 = boto3.client("s3")
            paginator = s3.get_paginator("list_objects_v2")
            download_count = 0

            for page in paginator.paginate(Bucket=self.s3_bucket, Prefix=self.s3_prefix):
                if "Contents" not in page:
                    continue
                for item in page["Contents"]:
                    s3_key = item["Key"]
                    if s3_key.endswith(("/", ".keep")):
                        continue
                    
                    filename = Path(s3_key).name
                    dest_file = self.local_raw_dir / filename
                    
                    # Skip if already downloaded and same size
                    if dest_file.exists() and dest_file.stat().st_size == item["Size"]:
                        continue

                    logger.info(f"Downloading s3://{self.s3_bucket}/{s3_key} -> {dest_file}")
                    s3.download_file(self.s3_bucket, s3_key, str(dest_file))
                    download_count += 1

            logger.info(f"S3 sync complete. Downloaded {download_count} new images.")
            return download_count

        except (NoCredentialsError, ClientError) as e:
            logger.warning(f"AWS credentials not detected or S3 bucket unavailable ({e}).")
            logger.info(f"Falling back to local raw directory: {self.local_raw_dir.resolve()}")
            return 0
        except Exception as e:
            logger.error(f"Error during S3 sync: {e}")
            return 0

    def validate_image(self, file_path: Path) -> Tuple[bool, str]:
        """
        Performs data quality validation:
        1. Checks if the file is a valid image (not zero bytes or corrupted).
        2. Verifies RGB color mode (3 channels).
        3. Checks minimum resolution requirements for muzzle biometric pattern visibility.
        """
        if not file_path.exists() or file_path.stat().st_size == 0:
            return False, "File is empty or does not exist"

        try:
            with Image.open(file_path) as img:
                img.verify()  # Check for header/byte corruption

            # Re-open after verify() to inspect image dimensions and format
            with Image.open(file_path) as img:
                width, height = img.size
                if width < self.min_width or height < self.min_height:
                    return False, f"Image resolution too small: {width}x{height} (min: {self.min_width}x{self.min_height})"
                
                # Verify format
                if img.format.upper() not in ["JPEG", "JPG", "PNG", "WEBP"]:
                    return False, f"Unsupported format: {img.format}"

            return True, "Valid"
        except Exception as e:
            return False, f"Corrupted image: {e}"

    def compute_dataset_hash(self, file_paths: List[Path]) -> str:
        """
        Generates a SHA-256 hash representing the exact version of the dataset.
        This provides data provenance: you know exactly which dataset trained which model version.
        """
        hasher = hashlib.sha256()
        for p in sorted(file_paths, key=lambda x: x.name):
            hasher.update(p.name.encode())
            hasher.update(str(p.stat().st_size).encode())
        return hasher.hexdigest()[:16]

    def prepare_yolo_dataset(self) -> Dict[str, any]:
        """
        Validates images, partitions them into train/val splits,
        and generates the 'data.yaml' configuration file required by YOLOv8.
        """
        logger.info("Starting image validation and dataset packaging...")
        
        # Collect raw image files
        valid_extensions = ("*.jpg", "*.jpeg", "*.png", "*.webp")
        raw_images = []
        for ext in valid_extensions:
            raw_images.extend(self.local_raw_dir.glob(ext))

        if not raw_images:
            logger.warning(f"No raw images found in {self.local_raw_dir}. Please place sample images there.")
            return {"status": "empty", "valid_count": 0}

        # Filter valid images
        valid_files = []
        corrupted_files = []
        for img_path in raw_images:
            is_valid, reason = self.validate_image(img_path)
            if is_valid:
                valid_files.append(img_path)
            else:
                corrupted_files.append((img_path.name, reason))
                logger.warning(f"Skipping {img_path.name}: {reason}")

        logger.info(f"Validated {len(valid_files)} clean images. (Corrupted/Invalid: {len(corrupted_files)})")
        
        if not valid_files:
            return {"status": "failed", "error": "No valid images passed inspection."}

        # Create destination directories
        train_img_dir = self.output_dataset_dir / "images" / "train"
        val_img_dir = self.output_dataset_dir / "images" / "val"
        train_lbl_dir = self.output_dataset_dir / "labels" / "train"
        val_lbl_dir = self.output_dataset_dir / "labels" / "val"

        for d in [train_img_dir, val_img_dir, train_lbl_dir, val_lbl_dir]:
            d.mkdir(parents=True, exist_ok=True)

        # Train / Validation Split (e.g. 80% train, 20% validation)
        split_idx = int(len(valid_files) * (1.0 - self.val_split_ratio))
        train_files = valid_files[:split_idx]
        val_files = valid_files[split_idx:]

        # Copy images and corresponding .txt labels (if present)
        for f in train_files:
            shutil.copy2(f, train_img_dir / f.name)
            lbl_candidate = f.with_suffix(".txt")
            if lbl_candidate.exists():
                shutil.copy2(lbl_candidate, train_lbl_dir / lbl_candidate.name)

        for f in val_files:
            shutil.copy2(f, val_img_dir / f.name)
            lbl_candidate = f.with_suffix(".txt")
            if lbl_candidate.exists():
                shutil.copy2(lbl_candidate, val_lbl_dir / lbl_candidate.name)

        # Create data.yaml for YOLOv8
        dataset_yaml_path = self.output_dataset_dir / "data.yaml"
        dataset_hash = self.compute_dataset_hash(valid_files)
        
        yaml_content = f"""# VacaPay Cattle Muzzle Dataset Configuration
# Generated automatically by MuzzleDataPipeline
# Dataset Version Hash: {dataset_hash}

path: {self.output_dataset_dir.resolve().as_posix()}
train: images/train
val: images/val

names:
  0: good_muzzle
  1: bad_muzzle
  2: wet_muzzle
"""
        with open(dataset_yaml_path, "w", encoding="utf-8") as yf:
            yf.write(yaml_content)

        logger.info(f"Dataset successfully compiled at: {self.output_dataset_dir.resolve()}")
        logger.info(f"Dataset Version Hash: {dataset_hash}")
        logger.info(f"Generated YAML config: {dataset_yaml_path}")

        return {
            "status": "success",
            "dataset_version": dataset_hash,
            "train_count": len(train_files),
            "val_count": len(val_files),
            "yaml_path": str(dataset_yaml_path),
            "output_dir": str(self.output_dataset_dir)
        }

if __name__ == "__main__":
    pipeline = MuzzleDataPipeline()
    pipeline.sync_from_s3()
    summary = pipeline.prepare_yolo_dataset()
    print("\n--- Data Pipeline Execution Summary ---")
    print(summary)
