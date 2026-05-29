variable "cluster_name"        { type = string }
variable "image_api"           { type = string }
variable "image_worker"        { type = string }
variable "image_trainer"       { type = string }
variable "vpc_id"              { type = string }
variable "private_subnet_ids"  { type = list(string) }
variable "public_subnet_ids"   { type = list(string) }
variable "db_endpoint"         { type = string }
variable "artifact_bucket_arn" { type = string }
variable "desired_api"         { type = number, default = 2 }
variable "desired_worker"      { type = number, default = 1 }

resource "aws_ecs_cluster" "main" {
  name = var.cluster_name
  setting { name = "containerInsights" value = "enabled" }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.cluster_name}/api"
  retention_in_days = 14
}

resource "aws_iam_role" "task_exec" {
  name = "${var.cluster_name}-task-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow",
                   Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "task_exec" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "${var.cluster_name}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow",
                   Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "task_s3" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow",
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource = [var.artifact_bucket_arn, "${var.artifact_bucket_arn}/*"]
    }]
  })
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.cluster_name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([{
    name      = "api"
    image     = var.image_api
    essential = true
    portMappings = [{ containerPort = 7421, hostPort = 7421 }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

data "aws_region" "current" {}

resource "aws_ecs_service" "api" {
  name            = "${var.cluster_name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_api
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.private_subnet_ids
    assign_public_ip = false
  }
}

output "cluster_name" { value = aws_ecs_cluster.main.name }
output "api_dns"      { value = "internal" }
