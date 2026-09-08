#!/usr/bin/env bash
# Prove a backup restores. A backup that has never been restored is a hope, not a backup —
# run this after the first real backup, and again before each season.
#
# Downloads the newest dump (or the S3 key passed as $1), restores it into a throwaway
# Postgres container, and prints the row counts that matter so a human can say "yes, that is
# the weekend I remember". Touches nothing in AWS beyond a read, and nothing local beyond a
# container it removes on exit.
#
# Needs: aws CLI, docker, pg_restore 16+ (`brew install libpq`).
set -euo pipefail

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${RPG_BACKUP_BUCKET:-rpg-backups-${ACCOUNT_ID}}"

KEY="${1:-$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix dumps/ \
  --query 'sort_by(Contents, &LastModified)[-1].Key' --output text)}"
if [ -z "$KEY" ] || [ "$KEY" = "None" ]; then
  echo "No dumps found in s3://${BUCKET}/dumps/ — run backup.sh first." >&2
  exit 1
fi

TMP=$(mktemp -t rpg-restore)
CONTAINER="rpg-restore-drill"
cleanup() {
  rm -f "$TMP"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Fetching s3://${BUCKET}/${KEY}…"
aws s3 cp "s3://${BUCKET}/${KEY}" "$TMP" --only-show-errors

echo "Starting scratch Postgres…"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=drill -p 5599:5432 postgres:16-alpine >/dev/null
until docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null; do sleep 1; done

docker exec "$CONTAINER" createdb -U postgres racing_drill
echo "Restoring…"
# --no-owner: roles from production don't exist in the scratch container, and ownership is
# irrelevant to the question being asked here.
pg_restore --no-owner --dbname "postgres://postgres:drill@localhost:5599/racing_drill" "$TMP"

echo
echo "=== The data that cannot be lost — check these against memory ==="
docker exec "$CONTAINER" psql -U postgres -d racing_drill -c "
  SELECT 'events'            AS what, count(*)::text AS rows FROM events
  UNION ALL SELECT 'workers',          count(*)::text FROM workers
  UNION ALL SELECT 'submissions',      count(*)::text FROM submissions
  UNION ALL SELECT 'submission_lines', count(*)::text FROM submission_lines
  UNION ALL SELECT 'charge_batches',   count(*)::text FROM charge_batches
  UNION ALL SELECT 'admin_actions',    count(*)::text FROM admin_actions
  UNION ALL SELECT 'latest submission', COALESCE(max(submitted_at)::text, '(none)') FROM submissions"

echo "Drill complete: ${KEY} restores. Scratch container removed."
