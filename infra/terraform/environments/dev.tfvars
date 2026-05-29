env                = "dev"
region             = "us-east-1"
vpc_id             = "vpc-REPLACE"
private_subnet_ids = ["subnet-REPLACE-a", "subnet-REPLACE-b"]
public_subnet_ids  = ["subnet-REPLACE-pub-a", "subnet-REPLACE-pub-b"]
image_api          = "ghcr.io/sanjays2402/adherence-ml:0.1.0"
image_worker       = "ghcr.io/sanjays2402/adherence-ml-worker:0.1.0"
image_trainer      = "ghcr.io/sanjays2402/adherence-ml-trainer:0.1.0"
