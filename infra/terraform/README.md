# Terraform Skeleton

Infrastructure as code for AWS deployment of adherence-ml.

Resources:
- ECS Fargate cluster (`modules/ecs`) running api / worker / trainer tasks
- RDS Postgres (`modules/rds`) for predictions + training_runs persistence
- S3 bucket (`modules/s3`) for serialized model artifacts (versioned, encrypted)
- IAM roles scoped to S3 GetObject/PutObject

Bootstrap:

    cd infra/terraform
    terraform init -backend-config="bucket=<your-tfstate>" \
                   -backend-config="key=adherence-ml/<env>/terraform.tfstate" \
                   -backend-config="region=us-east-1"
    terraform plan  -var-file=environments/dev.tfvars
    terraform apply -var-file=environments/dev.tfvars

This skeleton is intentionally minimal. Production deployments should add ALB +
TLS, WAF, a private VPC endpoint to ECR, KMS-CMK encryption on RDS/S3, and
optional EventBridge schedules for the trainer task.
