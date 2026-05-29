output "rds_endpoint"     { value = module.rds.endpoint }
output "artifact_bucket"  { value = module.artifact_store.bucket_name }
output "ecs_cluster"      { value = module.ecs.cluster_name }
output "api_dns"          { value = module.ecs.api_dns }
