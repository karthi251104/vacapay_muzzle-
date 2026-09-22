#!/bin/bash
# ============================================================
# VacaPay Airflow EC2 — One-Command Setup Script
# ============================================================
# WHAT THIS DOES (run this once on a fresh EC2 instance):
#   1. Updates the system packages
#   2. Installs Docker + Docker Compose
#   3. Copies your DAG and project code to the right folders
#   4. Starts Airflow (webserver + scheduler + postgres)
#   5. Opens port 8080 in the security group
#
# HOW TO RUN:
#   ssh -i your-key.pem ec2-user@<AIRFLOW-EC2-IP>
#   curl -O https://raw.githubusercontent.com/karthi251104/vacapay_muzzle-/main/aws/airflow/setup_airflow_ec2.sh
#   chmod +x setup_airflow_ec2.sh
#   ./setup_airflow_ec2.sh
# ============================================================

set -e  # Exit immediately if any command fails

# ── CONFIG ──────────────────────────────────────────────────
AIRFLOW_HOME=~/vacapay-airflow
GITHUB_REPO="https://github.com/karthi251104/vacapay_muzzle-.git"
EC2_REGION="ap-south-1"
AIRFLOW_EC2_SG="vacapay-airflow-sg"  # Security group name

echo "============================================================"
echo " VacaPay Airflow EC2 Setup"
echo "============================================================"

# ── STEP 1: Update System ────────────────────────────────────
echo ""
echo "[1/6] Updating system packages..."
sudo yum update -y 2>/dev/null || sudo apt-get update -y

# ── STEP 2: Install Docker ───────────────────────────────────
echo ""
echo "[2/6] Installing Docker..."

# Amazon Linux 2023
if command -v yum &>/dev/null; then
    sudo yum install -y docker git
    sudo systemctl enable docker
    sudo systemctl start docker
    sudo usermod -aG docker ec2-user
else
    # Ubuntu fallback
    sudo apt-get install -y docker.io docker-compose-v2 git
    sudo systemctl enable docker
    sudo systemctl start docker
    sudo usermod -aG docker ubuntu
fi

# Install Docker Compose V2 plugin if not already installed
if ! docker compose version &>/dev/null; then
    echo "Installing Docker Compose V2..."
    sudo curl -SL https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64 \
        -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    sudo ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
fi

echo "Docker version: $(docker --version)"
echo "Docker Compose version: $(docker compose version)"

# ── STEP 3: Clone VacaPay Repo ───────────────────────────────
echo ""
echo "[3/6] Cloning VacaPay repository..."

if [ -d ~/vacapay_muzzle ]; then
    echo "Repo already exists, pulling latest..."
    cd ~/vacapay_muzzle && git pull
else
    git clone "$GITHUB_REPO" ~/vacapay_muzzle
fi

# ── STEP 4: Set Up Airflow Folder Structure ──────────────────
echo ""
echo "[4/6] Setting up Airflow directory..."

mkdir -p "$AIRFLOW_HOME/dags"
mkdir -p "$AIRFLOW_HOME/vacapay_code/backend/mlops"

# Copy the DAG file into Airflow's dags folder
cp ~/vacapay_muzzle/backend/mlops/airflow_dags/vacapay_retraining_dag.py \
   "$AIRFLOW_HOME/dags/"

# Copy the MLOps backend code so DAG can import it
cp -r ~/vacapay_muzzle/backend/mlops/* \
   "$AIRFLOW_HOME/vacapay_code/backend/mlops/"

# Create __init__.py files so Python treats folders as packages
touch "$AIRFLOW_HOME/vacapay_code/__init__.py"
touch "$AIRFLOW_HOME/vacapay_code/backend/__init__.py"
touch "$AIRFLOW_HOME/vacapay_code/backend/mlops/__init__.py"

# Copy docker-compose.yml to Airflow home
cp ~/vacapay_muzzle/aws/airflow/docker-compose.yml "$AIRFLOW_HOME/"

echo "DAG copied: $AIRFLOW_HOME/dags/vacapay_retraining_dag.py"
echo "Code copied: $AIRFLOW_HOME/vacapay_code/"

# ── STEP 5: Install MLflow on Host (for tracking) ────────────
echo ""
echo "[5/6] Installing MLflow on EC2 host..."
pip3 install mlflow --quiet 2>/dev/null || sudo pip3 install mlflow --quiet

# Start MLflow tracking server in background
nohup mlflow server \
    --host 0.0.0.0 \
    --port 5000 \
    --backend-store-uri sqlite:///~/mlflow.db \
    --default-artifact-root ~/mlartifacts \
    > ~/mlflow.log 2>&1 &

echo "MLflow started at http://$(curl -s ifconfig.me):5000"

# ── STEP 6: Start Airflow via Docker Compose ─────────────────
echo ""
echo "[6/6] Starting Airflow services..."
cd "$AIRFLOW_HOME"

# Pull images first (avoids timeout during compose up)
docker compose pull

# Start all services in detached mode
docker compose up -d

echo ""
echo "============================================================"
echo " Waiting for Airflow to initialize (60 seconds)..."
echo "============================================================"
sleep 60

# Check if services are running
docker compose ps

# Get the public IP
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)

echo ""
echo "============================================================"
echo " AIRFLOW IS READY!"
echo "============================================================"
echo ""
echo "  Airflow UI  : http://$PUBLIC_IP:8080"
echo "  Username    : admin"
echo "  Password    : vacapay2026"
echo ""
echo "  MLflow UI   : http://$PUBLIC_IP:5000"
echo ""
echo "  Your DAG    : vacapay_cattle_retraining_dag"
echo "  Schedule    : Every Sunday at 2:00 AM UTC"
echo ""
echo "  To trigger manually:"
echo "  docker exec -it \$(docker ps -qf name=airflow-scheduler) \\"
echo "    airflow dags trigger vacapay_cattle_retraining_dag"
echo ""
echo "============================================================"
