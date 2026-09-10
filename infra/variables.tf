variable "aws_profile" {
  description = <<-EOT
    Named AWS CLI profile terraform authenticates with. Pinned rather than left to the
    ambient credential chain so an apply cannot silently run against whatever profile the
    shell happened to have — this stack creates IAM roles and a database, and "wrong
    account" is not a mistake you notice from the plan output.

    The `rpg` user is a dedicated single-purpose operator identity (AdministratorAccess:
    the stack creates four IAM roles, so iam:CreateRole + iam:PassRole are unavoidable and
    any policy granting those is admin-equivalent anyway). Set to "" to fall back to the
    default credential chain — for a second operator whose profile is named differently.
  EOT
  type        = string
  default     = "rpg"
}

variable "region" {
  description = "Primary region. Oregon: the team is Oregon-based, and latency to a paddock is dominated by cellular anyway."
  type        = string
  default     = "us-west-2"
}

variable "backup_region" {
  description = "Where the backup bucket replicates to. Only S3 lives here."
  type        = string
  default     = "us-east-1"
}

variable "app_base_url" {
  description = <<-EOT
    Public base URL minted into worker magic links (APP_BASE_URL). Deliberately empty on the
    first apply — App Runner assigns its domain only once the service exists — so the deploy
    is two-step: apply, read the service_url output, set this, apply again. A wrong value
    does not break the app; it breaks every link the admin prints, silently.
  EOT
  type        = string
  default     = ""
}

variable "qbo_environment" {
  description = "sandbox | production. Kept as reviewable plain config, not a secret: flipping this to production is exactly the kind of change that should show up in a diff."
  type        = string
  default     = "sandbox"
  validation {
    condition     = contains(["sandbox", "production"], var.qbo_environment)
    error_message = "qbo_environment must be sandbox or production."
  }
}

variable "event_time_zone" {
  description = "The track's zone: worker links expire at end-of-day-after-event *in this zone* (src/workers.ts)."
  type        = string
  default     = "America/Los_Angeles"
}

variable "db_ingress_cidrs" {
  description = <<-EOT
    Who may reach Postgres :5432. The database is deliberately on a public endpoint — see the
    header of aurora.tf for the reasoning and the compensating controls — and this is the
    narrowing lever: replace the default with your home/shop CIDRs once they are known.
    App Runner egress IPs are dynamic, so the app's own access cannot be allowlisted tighter
    than this without moving to VPC egress (and its always-on NAT cost).
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "service_name" {
  description = <<-EOT
    App Runner service name. Not "rpg" like every other resource here: App Runner enforces
    a 4-character minimum (`[A-Za-z0-9][A-Za-z0-9-_]{3,39}`) and rejects a 3-character name
    at create time. Everything else in this stack — ECR repo, IAM roles, DB cluster — is
    still plain "rpg"; this is the one place the name has to differ.

    infra/scripts/_env.sh carries the same value as RPG_SERVICE_NAME, because pause.sh and
    resume.sh find the service by listing App Runner and matching on this name. Change one
    and you must change the other, or those two scripts report the service as missing.
  EOT
  type        = string
  default     = "rpg-app"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-_]{3,39}$", var.service_name))
    error_message = "service_name must match App Runner's [A-Za-z0-9][A-Za-z0-9-_]{3,39} — 4 to 40 characters."
  }
}

variable "github_repo" {
  description = "owner/name of the GitHub repo allowed to push images via OIDC. No stored AWS keys in GitHub."
  type        = string
  default     = "fion-noif/rpg"
}

variable "github_owner_id" {
  description = <<-EOT
    Immutable numeric ID of the GitHub *owner*. GitHub now mints OIDC subjects containing
    these IDs alongside the names — `repo:owner@<owner_id>/name@<repo_id>:ref:…` — so a repo
    that is deleted and recreated under the same name does not inherit this role's trust.
    The trust policy accepts both that form and the older name-only form (github-oidc.tf).

    Get it with: gh api repos/<owner>/<name> --jq '.owner.id'
  EOT
  type        = number
  default     = 270454910
}

variable "github_repository_id" {
  description = <<-EOT
    Immutable numeric ID of the GitHub repo itself. See github_owner_id.

    Get it with: gh api repos/<owner>/<name> --jq '.id'
  EOT
  type        = number
  default     = 1344382611
}
