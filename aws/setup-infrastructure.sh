#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Vacapay AWS Infrastructure Setup — Step by Step
# ═══════════════════════════════════════════════════════════════════════
#
# This script creates ALL the AWS resources needed to run Vacapay.
# DO NOT run this as a single script! Read each section, understand it,
# then run the commands one by one.
#
# Prerequisites:
#   1. AWS CLI installed and configured (aws configure)
#   2. Docker Desktop installed
#   3. Git LFS installed (for ML model files)
#
# ═══════════════════════════════════════════════════════════════════════

# ── CONFIGURATION ────────────────────────────────────────────────────
# Change these values to match your setup
AWS_REGION="ap-south-1"                    # Mumbai region
AWS_ACCOUNT_ID="591064574408"  # Find in AWS Console top-right
ECR_REPO_NAME="vacapay-backend"
ECS_CLUSTER_NAME="vacapay-cluster"
ECS_SERVICE_NAME="vacapay-service"
VPC_CIDR="10.0.0.0/16"
PUBLIC_SUBNET_CIDR="10.0.1.0/24"
INSTANCE_TYPE="m7i-flex.large"             # 2 vCPU, 8 GB RAM (free tier)

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 1: Verify AWS CLI is working"
echo "═══════════════════════════════════════════════════════"
# This command should print your account ID and IAM user
# If it fails, run: aws configure
aws sts get-caller-identity

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 2: Create ECR Repository"
echo "═══════════════════════════════════════════════════════"
# ECR = Elastic Container Registry = AWS's private Docker Hub
#
# WHY ECR?
#   - Private: only YOUR AWS account can access images
#   - Integrated: ECS pulls from ECR without extra auth setup
#   - Scanning: automatically scans images for security vulnerabilities
#   - Cost: ~$0.10 per GB per month (your ~2.5 GB image = ~$0.25/month)

aws ecr create-repository \
  --repository-name "$ECR_REPO_NAME" \
  --region "$AWS_REGION" \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability MUTABLE

# MUTABLE means you can overwrite the "latest" tag.
# In production, use IMMUTABLE to prevent accidental overwrites.

echo ""
echo "📝 Save this URI — you'll need it to push images:"
echo "   ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 3: Create VPC (Virtual Private Cloud)"
echo "═══════════════════════════════════════════════════════"
# VPC = Your private network in AWS
#
# WHAT HAPPENS HERE:
#   1. Create a VPC (the building)
#   2. Create a public subnet (the front desk — internet-accessible)
#   3. Create an Internet Gateway (the main door)
#   4. Create a route table (signs in the hallway)
#   5. Create security groups (door locks)

# 3a. Create the VPC
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block "$VPC_CIDR" \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=vacapay-vpc}]" \
  --query 'Vpc.VpcId' \
  --output text)
echo "✅ Created VPC: $VPC_ID"

# Enable DNS hostnames (required for ECS service discovery)
aws ec2 modify-vpc-attribute \
  --vpc-id "$VPC_ID" \
  --enable-dns-hostnames '{"Value": true}'

# 3b. Create Public Subnet
SUBNET_ID=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block "$PUBLIC_SUBNET_CIDR" \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=vacapay-public-subnet}]" \
  --query 'Subnet.SubnetId' \
  --output text)
echo "✅ Created Subnet: $SUBNET_ID"

# Enable auto-assign public IP (so EC2 instances get a public IP)
aws ec2 modify-subnet-attribute \
  --subnet-id "$SUBNET_ID" \
  --map-public-ip-on-launch

# 3c. Create Internet Gateway (the main door to the internet)
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=vacapay-igw}]" \
  --query 'InternetGateway.InternetGatewayId' \
  --output text)
echo "✅ Created Internet Gateway: $IGW_ID"

# Attach Internet Gateway to VPC (connect the door to the building)
aws ec2 attach-internet-gateway \
  --internet-gateway-id "$IGW_ID" \
  --vpc-id "$VPC_ID"

# 3d. Create Route Table (signs in the hallway)
RTB_ID=$(aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=vacapay-public-rt}]" \
  --query 'RouteTable.RouteTableId' \
  --output text)
echo "✅ Created Route Table: $RTB_ID"

# Add route: "To reach the internet (0.0.0.0/0), go through the Internet Gateway"
aws ec2 create-route \
  --route-table-id "$RTB_ID" \
  --destination-cidr-block "0.0.0.0/0" \
  --gateway-id "$IGW_ID"

# Associate route table with subnet
aws ec2 associate-route-table \
  --route-table-id "$RTB_ID" \
  --subnet-id "$SUBNET_ID"

# 3e. Create Security Groups (firewall rules)

# Security Group for the EC2/ECS instance
SG_ID=$(aws ec2 create-security-group \
  --group-name "vacapay-ecs-sg" \
  --description "Security group for Vacapay ECS container" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' \
  --output text)
echo "✅ Created Security Group: $SG_ID"

# Allow SSH (port 22) — ONLY from your IP for security
# Replace YOUR_IP with your actual IP (find at: https://checkip.amazonaws.com)
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port 22 \
  --cidr "${MY_IP}/32"
echo "✅ SSH allowed from your IP: ${MY_IP}"

# Allow HTTP (port 80) — from anywhere (for the API)
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port 80 \
  --cidr "0.0.0.0/0"

# Allow HTTPS (port 443) — from anywhere
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port 443 \
  --cidr "0.0.0.0/0"

# Allow port 3000 — from anywhere (your Express server)
# In production with ALB, you'd restrict this to ALB only
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port 3000 \
  --cidr "0.0.0.0/0"

echo ""
echo "📝 Save these IDs — you'll need them:"
echo "   VPC:     $VPC_ID"
echo "   Subnet:  $SUBNET_ID"
echo "   SG:      $SG_ID"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 4: Create IAM Roles"
echo "═══════════════════════════════════════════════════════"
# IAM Roles = "Who can do what"
#
# We need TWO roles:
#   1. ecsTaskExecutionRole — lets ECS pull images from ECR + send logs
#   2. vacapayTaskRole — lets the running container access Secrets Manager

# 4a. Create ECS Task Execution Role
# This trust policy says: "ECS service is allowed to assume this role"
cat > /tmp/ecs-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document file:///tmp/ecs-trust-policy.json

# Attach the AWS-managed policy that gives ECR pull + CloudWatch logs
aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Also allow reading secrets from Secrets Manager
cat > /tmp/secrets-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:*:*:secret:vacapay/*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name VacapaySecretsAccess \
  --policy-document file:///tmp/secrets-policy.json

echo "✅ Created ecsTaskExecutionRole with ECR + CloudWatch + Secrets access"

# 4b. Create Task Role (for the running container)
aws iam create-role \
  --role-name vacapayTaskRole \
  --assume-role-policy-document file:///tmp/ecs-trust-policy.json

echo "✅ Created vacapayTaskRole"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 5: Store Secrets in AWS Secrets Manager"
echo "═══════════════════════════════════════════════════════"
# WHY SECRETS MANAGER?
#   On Azure VM: secrets were in /etc/vacapay.env (a file on disk)
#   On AWS ECS:  secrets are in Secrets Manager (encrypted, audited)
#
# Benefits:
#   - Encrypted at rest with AWS KMS
#   - Access is logged (CloudTrail audit trail)
#   - Can rotate without redeploying
#   - Team members deploy without seeing passwords
#
# IMPORTANT: Replace the placeholder values below with YOUR actual secrets!

aws secretsmanager create-secret \
  --name "vacapay/production" \
  --description "Vacapay backend production secrets" \
  --secret-string '{
    "JWT_SECRET": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
    "MONGODB_URI": "REPLACE_WITH_YOUR_MONGODB_ATLAS_URI",
    "CLOUDINARY_CLOUD_NAME": "REPLACE_WITH_YOUR_CLOUD_NAME",
    "CLOUDINARY_API_KEY": "REPLACE_WITH_YOUR_API_KEY",
    "CLOUDINARY_API_SECRET": "REPLACE_WITH_YOUR_API_SECRET",
    "PINECONE_API_KEY": "REPLACE_WITH_YOUR_PINECONE_KEY",
    "PINECONE_INDEX_HOST": "REPLACE_WITH_YOUR_PINECONE_HOST",
    "CORS_ORIGINS": "https://your-admin.netlify.app,capacitor://localhost,https://localhost"
  }'
echo "✅ Created secrets in Secrets Manager"
echo "⚠️  Remember to update the placeholder values with real secrets!"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 6: Create ECS Cluster"
echo "═══════════════════════════════════════════════════════"
# ECS Cluster = A group of machines that can run containers
# The cluster itself is FREE — you only pay for the EC2 instances in it

aws ecs create-cluster \
  --cluster-name "$ECS_CLUSTER_NAME" \
  --settings "name=containerInsights,value=enabled"
echo "✅ Created ECS Cluster: $ECS_CLUSTER_NAME"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 7: Launch EC2 Instance for ECS"
echo "═══════════════════════════════════════════════════════"
# We need an EC2 instance that:
#   1. Has the ECS agent installed (to receive container tasks)
#   2. Has Docker installed (to run containers)
#   3. Has enough RAM for PyTorch/DINOv2 (m7i-flex.large = 8 GB)
#
# We use the "ECS-optimized Amazon Linux 2023" AMI which has
# Docker + ECS agent pre-installed.

# Find the latest ECS-optimized AMI
ECS_AMI=$(aws ssm get-parameters \
  --names /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id \
  --query 'Parameters[0].Value' \
  --output text)
echo "Using ECS-optimized AMI: $ECS_AMI"

# Create a key pair for SSH access
aws ec2 create-key-pair \
  --key-name vacapay-key \
  --query 'KeyMaterial' \
  --output text > vacapay-key.pem
chmod 400 vacapay-key.pem
echo "✅ SSH key saved as vacapay-key.pem"

# Create the EC2 instance with ECS agent user data
# The user data script tells the ECS agent which cluster to join
cat > /tmp/user-data.sh << EOF
#!/bin/bash
echo "ECS_CLUSTER=${ECS_CLUSTER_NAME}" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_TASK_IAM_ROLE=true" >> /etc/ecs/ecs.config
mkdir -p /var/lib/vacapay/data
EOF

# Create an IAM instance profile for the EC2 instance
# This role lets the EC2 instance register with ECS and pull from ECR
aws iam create-role \
  --role-name ecsInstanceRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name ecsInstanceRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role

aws iam create-instance-profile \
  --instance-profile-name ecsInstanceProfile

aws iam add-role-to-instance-profile \
  --instance-profile-name ecsInstanceProfile \
  --role-name ecsInstanceRole

# Wait for the instance profile to propagate
echo "⏳ Waiting 10 seconds for IAM profile to propagate..."
sleep 10

# Launch the EC2 instance
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$ECS_AMI" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name vacapay-key \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --iam-instance-profile Name=ecsInstanceProfile \
  --user-data file:///tmp/user-data.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=vacapay-ecs-instance}]" \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --query 'Instances[0].InstanceId' \
  --output text)
echo "✅ Launched EC2 Instance: $INSTANCE_ID"
echo "⏳ Wait 2-3 minutes for the instance to fully boot and join ECS..."

# Get the public IP
sleep 60
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)
echo "🌐 EC2 Public IP: $PUBLIC_IP"
echo "🔗 SSH: ssh -i vacapay-key.pem ec2-user@${PUBLIC_IP}"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 8: Register Task Definition"
echo "═══════════════════════════════════════════════════════"
# Register the task definition from the JSON file
# IMPORTANT: First update aws/task-definition.json with your
# actual AWS_ACCOUNT_ID (replace YOUR_ACCOUNT_ID)

echo "⚠️  Before running this, update aws/task-definition.json:"
echo "   Replace YOUR_ACCOUNT_ID with: $AWS_ACCOUNT_ID"
echo ""
echo "Then run:"
echo "   aws ecs register-task-definition --cli-input-json file://aws/task-definition.json"

echo "═══════════════════════════════════════════════════════"
echo "  PHASE 9: Create ECS Service"
echo "═══════════════════════════════════════════════════════"
# ECS Service = "Always keep 1 container running"
# If the container crashes, the service automatically restarts it
echo "Run this after the Task Definition is registered:"
echo ""
echo "aws ecs create-service \\"
echo "  --cluster $ECS_CLUSTER_NAME \\"
echo "  --service-name $ECS_SERVICE_NAME \\"
echo "  --task-definition vacapay-backend \\"
echo "  --desired-count 1 \\"
echo "  --launch-type EC2 \\"
echo "  --network-configuration 'awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}'"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PHASE 10: Build & Push Docker Image"
echo "═══════════════════════════════════════════════════════"
echo "Run these commands from your project root:"
echo ""
echo "# 1. Login to ECR"
echo "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo ""
echo "# 2. Build"
echo "docker build -t vacapay-backend ."
echo ""
echo "# 3. Tag"
echo "docker tag vacapay-backend:latest ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}:latest"
echo ""
echo "# 4. Push"
echo "docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}:latest"
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  🎉 SETUP COMPLETE!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Your Vacapay backend will be available at:"
echo "  http://${PUBLIC_IP}:3000/api/health"
echo ""
echo "Next steps:"
echo "  1. Update aws/task-definition.json with your account ID"
echo "  2. Push the Docker image to ECR"
echo "  3. Register the task definition"
echo "  4. Create the ECS service"
echo "  5. Set up GitHub Actions secrets for CI/CD"
echo ""
echo "Monitor:"
echo "  ECS Console: https://console.aws.amazon.com/ecs"
echo "  CloudWatch:  https://console.aws.amazon.com/cloudwatch"
