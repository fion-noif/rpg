#!/usr/bin/env bash
# Mothball the system between races: fresh backup first, then pause App Runner.
#
# The backup is not optional and runs first on purpose — pausing is the moment the data
# stops changing, so the dump taken here is a perfect archive of the weekend's final state.
# Aurora needs no command: at min-capacity 0 it suspends itself once idle (aurora.tf), which
# the paused app guarantees. Paused cost is storage and pennies — see docs/deploy.md.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=_env.sh
. "$SCRIPT_DIR/_env.sh"

"$SCRIPT_DIR/backup.sh"

ARN=$(aws apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${RPG_SERVICE_NAME}'].ServiceArn | [0]" --output text)
if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "No App Runner service named '${RPG_SERVICE_NAME}' found in ${AWS_REGION}." >&2
  exit 1
fi

echo "Pausing ${ARN}…"
aws apprunner pause-service --service-arn "$ARN" --query "Service.Status" --output text
echo "Paused. Worker links minted for past events are dead anyway — their events have ended."
echo "Resume with infra/scripts/resume.sh before the next race weekend."
