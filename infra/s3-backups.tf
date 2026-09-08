# Backup layers 2 and 3: a versioned dump bucket, replicated to a second region.
#
# Layer 1 (Aurora PITR, aurora.tf) answers "undo the last bad write" with a ~5-minute RPO but
# a 35-day horizon. This bucket answers the other two questions: "what did the database say
# in March" (dumps are kept for years — it is billing history) and "what if the region or the
# account's primary copies are gone" (cross-region replica). Dumps are written by
# infra/scripts/backup.sh — by hand after a race weekend, and always by pause.sh, so the act
# of mothballing the system is what guarantees a fresh archive of its final state.

resource "aws_s3_bucket" "backups" {
  bucket = "rpg-backups-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

# Versioning is the defense against the scariest failure: a *bad* backup overwriting a good
# one (wrong database, empty dump, truncated stream). Every upload is a new version; nothing
# is ever really overwritten.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Dumps are read within days (restore drill) or years later (bookkeeping questions) —
  # nothing in between. Glacier IR keeps them millisecond-retrievable at archive prices.
  rule {
    id     = "archive"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    noncurrent_version_expiration {
      # Superseded *versions* (an object overwritten in place) linger a year, then go.
      # Distinct dump objects — the normal case, each keyed by timestamp — never expire.
      noncurrent_days = 365
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- The cross-region replica -------------------------------------------------------------

resource "aws_s3_bucket" "backups_replica" {
  provider = aws.backup_region
  bucket   = "rpg-backups-replica-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "backups_replica" {
  provider = aws.backup_region
  bucket   = aws_s3_bucket.backups_replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "backups_replica" {
  provider                = aws.backup_region
  bucket                  = aws_s3_bucket.backups_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "s3_replication" {
  name = "rpg-backup-replication"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "s3_replication" {
  name = "replicate-backups"
  role = aws_iam_role.s3_replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = [aws_s3_bucket.backups.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
        Resource = ["${aws_s3_bucket.backups.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource = ["${aws_s3_bucket.backups_replica.arn}/*"]
      }
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "backups" {
  depends_on = [aws_s3_bucket_versioning.backups, aws_s3_bucket_versioning.backups_replica]

  role   = aws_iam_role.s3_replication.arn
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "everything"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      # Deletes do NOT replicate: an accidental (or malicious) delete in the primary leaves
      # the replica intact. Cleaning the replica is a deliberate second act, by design.
      status = "Disabled"
    }
    destination {
      bucket        = aws_s3_bucket.backups_replica.arn
      storage_class = "STANDARD_IA"
    }
  }
}
