# The app: one App Runner service running the ECR image.
#
# App Runner over ECS-behind-an-ALB for one load-bearing reason: it has a real *pause*
# operation. Paused, the service costs nothing — an ALB alone costs ~$16/mo whether or not
# anyone races, which fails the pause-for-weeks requirement before anything else is priced.
# infra/scripts/pause.sh and resume.sh drive it; Aurora suspends itself (aurora.tf).

# Pinned to exactly one instance, and this is not about cost: the admin login throttle
# (src/admin-auth.ts) is in-process memory, so N instances would mean N× the allowed
# password attempts — and the migration-on-boot entrypoint assumes no rolling overlap.
# Scaling past 1 is an application change, not a Terraform change.
resource "aws_apprunner_auto_scaling_configuration_version" "single" {
  auto_scaling_configuration_name = "rpg-single"
  min_size                        = 1
  max_size                        = 1
}

# Role App Runner uses to *pull the image* from ECR.
resource "aws_iam_role" "apprunner_ecr_access" {
  name = "rpg-apprunner-ecr-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# Role the *running container* holds: read exactly the four SSM secrets, nothing else.
# (SecureStrings use the AWS-managed aws/ssm KMS key, whose key policy admits account
# principals that hold the ssm permission — no explicit kms:Decrypt grant needed.)
resource "aws_iam_role" "apprunner_instance" {
  name = "rpg-apprunner-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "tasks.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "apprunner_instance_ssm" {
  name = "read-rpg-secrets"
  role = aws_iam_role.apprunner_instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameters", "ssm:GetParameter"]
      Resource = [for p in aws_ssm_parameter.secret : p.arn]
    }]
  })
}

resource "aws_apprunner_service" "app" {
  service_name = var.service_name

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }
    # Deploys happen when GitHub Actions pushes a new :latest — no Terraform run needed to
    # ship code. Terraform runs are for infrastructure and config changes only.
    auto_deployments_enabled = true

    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:latest"
      image_repository_type = "ECR"
      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          QBO_ENVIRONMENT = var.qbo_environment
          APP_BASE_URL    = var.app_base_url
          EVENT_TIME_ZONE = var.event_time_zone
        }
        runtime_environment_secrets = {
          QBO_CLIENT_ID     = aws_ssm_parameter.secret["qbo-client-id"].arn
          QBO_CLIENT_SECRET = aws_ssm_parameter.secret["qbo-client-secret"].arn
          ADMIN_SECRET      = aws_ssm_parameter.secret["admin-secret"].arn
          DATABASE_URL      = aws_ssm_parameter.secret["database-url"].arn
        }
      }
    }
  }

  instance_configuration {
    cpu               = "1024" # 1 vCPU / 2 GB: Next SSR headroom; a paddock is not a load test
    memory            = "2048"
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.single.arn

  # TCP, not HTTP, and that choice is load-bearing: every HTTP route on this app touches the
  # database (even "/" resolves the session token), so an HTTP health check would poke
  # Postgres forever and Aurora would never reach its min-capacity-0 pause. TCP proves the
  # process is up without waking the database. Corollary, documented in docs/deploy.md:
  # never point an external uptime pinger at this app, for the same reason.
  health_check_configuration {
    protocol            = "TCP"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  # First-boot ordering: the service is created watching :latest, which does not exist until
  # the GitHub workflow's first push. App Runner reports CREATE_FAILED if it can't pull, so
  # docs/deploy.md sequences the first image push *before* the first full apply.
  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr_access]
}
