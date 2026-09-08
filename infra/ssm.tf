# The four true secrets, as SSM SecureString parameters. App Runner injects them into the
# container's environment by ARN (apprunner.tf) — no .env file exists anywhere in production.
#
# Terraform owns the parameter *names*; the *values* are written once with the aws CLI
# (docs/deploy.md) and ignored here, so no secret ever passes through Terraform state or a
# git diff. The placeholder is deliberately loud: an app started before the values are set
# fails with "CHANGE-ME" in the error, not with something that looks half-plausible.
#
# Everything else from .env.example (QBO_ENVIRONMENT, APP_BASE_URL, EVENT_TIME_ZONE) is plain
# reviewable config in apprunner.tf — being visible in a diff is a feature for those.

locals {
  secret_names = [
    "qbo-client-id",
    "qbo-client-secret",
    "admin-secret",
    "database-url", # carries the DB password, hence secret; assembled per docs/deploy.md
  ]
}

resource "aws_ssm_parameter" "secret" {
  for_each = toset(local.secret_names)

  name  = "/rpg/${each.key}"
  type  = "SecureString"
  value = "CHANGE-ME"

  lifecycle {
    ignore_changes = [value]
  }
}
