output "service_url" {
  description = "The app. Feed this back into var.app_base_url (second apply) so magic links mint correctly."
  value       = "https://${aws_apprunner_service.app.service_url}"
}

output "service_arn" {
  description = "For infra/scripts/pause.sh and resume.sh."
  value       = aws_apprunner_service.app.arn
}

output "ecr_repository_url" {
  description = "Where the GitHub workflow pushes. Also set as the AWS_ECR_REPOSITORY repo variable."
  value       = aws_ecr_repository.app.repository_url
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repo variable in GitHub."
  value       = aws_iam_role.github_deploy.arn
}

output "db_endpoint" {
  description = "Postgres host, for assembling the DATABASE_URL secret (docs/deploy.md)."
  value       = aws_rds_cluster.main.endpoint
}

output "db_master_secret_arn" {
  description = "The RDS-managed Secrets Manager secret holding the racing user's password."
  value       = one(aws_rds_cluster.main.master_user_secret[*].secret_arn)
}

output "backup_bucket" {
  description = "For infra/scripts/backup.sh and restore-drill.sh."
  value       = aws_s3_bucket.backups.bucket
}
