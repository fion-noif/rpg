#!/usr/bin/env bash
# Dump the production database to the backup bucket (layer 3 of three — see s3-backups.tf).
#
# Runs from the operator's laptop: the DB endpoint is public-with-TLS precisely so this
# script needs no bastion, no ECS task, and no always-on infrastructure. Run it after every
# race weekend; pause.sh runs it for you.
#
# Needs: aws CLI (authenticated), pg_dump 16+ (`brew install libpq && brew link --force libpq`).
set -euo pipefail

# The connection string comes from SSM — the same value the app uses — so a backup can never
# quietly dump the wrong database. Overridable for the restore drill.
DATABASE_URL="${DATABASE_URL:-$(aws ssm get-parameter --name /rpg/database-url --with-decryption --query Parameter.Value --output text)}"
if [ "$DATABASE_URL" = "CHANGE-ME" ]; then
  echo "SSM /rpg/database-url is still the placeholder — see docs/deploy.md." >&2
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${RPG_BACKUP_BUCKET:-rpg-backups-${ACCOUNT_ID}}"
KEY="dumps/racing-$(date -u +%Y%m%dT%H%M%SZ).dump"
TMP=$(mktemp -t rpg-dump)
trap 'rm -f "$TMP"' EXIT

# Dump to a local file first, not straight into the pipe to S3: it lets the dump be
# *validated* before anything lands in the bucket. A backup that uploads garbage on a flaky
# paddock connection is worse than one that fails loudly.
echo "Dumping…"
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="$TMP"

# pg_restore --list parses the archive TOC — a truncated or empty dump fails here.
pg_restore --list "$TMP" >/dev/null
SIZE=$(wc -c <"$TMP" | tr -d ' ')
if [ "$SIZE" -lt 10000 ]; then
  echo "Dump is only ${SIZE} bytes — that is not a database. Refusing to upload." >&2
  exit 1
fi

echo "Uploading ${SIZE} bytes to s3://${BUCKET}/${KEY}…"
aws s3 cp "$TMP" "s3://${BUCKET}/${KEY}" --only-show-errors

echo "OK: s3://${BUCKET}/${KEY}"
echo "Restore drill: infra/scripts/restore-drill.sh   (run it — an untested backup is a hope)"
