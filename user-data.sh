#!/bin/bash
echo "ECS_CLUSTER=vacapay-cluster" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_TASK_IAM_ROLE=true" >> /etc/ecs/ecs.config
mkdir -p /var/lib/vacapay/data
