# Racing parts app infrastructure. One environment, one file set — there is no
# staging/production split because there is one team and one race calendar.
#
# State is local (infra/terraform.tfstate, gitignored). Acceptable while exactly one person
# runs terraform; move to an S3 backend the day a second operator appears. Note the state
# never holds secrets by design: SSM parameter *values* are written with the aws CLI after
# apply (see ssm.tf), and the database password is RDS-managed (see aurora.tf).

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { app = "rpg" }
  }
}

# Second region, exclusively for the backup bucket's replica (s3-backups.tf): a copy of the
# dumps that survives a regional outage or a fat-fingered bucket deletion in the primary.
provider "aws" {
  alias  = "backup_region"
  region = var.backup_region
  default_tags {
    tags = { app = "rpg" }
  }
}

data "aws_caller_identity" "current" {}
