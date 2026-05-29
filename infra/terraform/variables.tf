variable "region"             { type = string, default = "us-east-1" }
variable "env"                { type = string, default = "dev" }
variable "name_prefix"        { type = string, default = "adherence-ml" }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "public_subnet_ids"  { type = list(string) }
variable "db_instance_class"  { type = string, default = "db.t4g.small" }
variable "image_api"          { type = string }
variable "image_worker"       { type = string }
variable "image_trainer"      { type = string }
variable "desired_api"        { type = number, default = 2 }
variable "desired_worker"     { type = number, default = 1 }
