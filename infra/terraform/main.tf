terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
  backend "s3" {
    # configure via -backend-config in CI
    bucket = "REPLACE-ME-tfstate"
    key    = "adherence-ml/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project = "adherence-ml"
      env     = var.env
      owner   = "platform"
    }
  }
}

module "artifact_store" {
  source        = "./modules/s3"
  bucket_name   = "${var.name_prefix}-models-${var.env}"
  force_destroy = var.env != "prod"
}

module "rds" {
  source       = "./modules/rds"
  identifier   = "${var.name_prefix}-${var.env}"
  db_name      = "adherence"
  db_user      = "adherence"
  vpc_id       = var.vpc_id
  subnet_ids   = var.private_subnet_ids
  instance_class = var.db_instance_class
}

module "ecs" {
  source              = "./modules/ecs"
  cluster_name        = "${var.name_prefix}-${var.env}"
  image_api           = var.image_api
  image_worker        = var.image_worker
  image_trainer       = var.image_trainer
  vpc_id              = var.vpc_id
  private_subnet_ids  = var.private_subnet_ids
  public_subnet_ids   = var.public_subnet_ids
  db_endpoint         = module.rds.endpoint
  artifact_bucket_arn = module.artifact_store.arn
  desired_api         = var.desired_api
  desired_worker      = var.desired_worker
}
