#!/usr/bin/env bash
# Wake the system for a race weekend. Aurora resumes itself on the app's first query
# (~15 seconds, once); nothing else to do. Run this a day before the weekend, not from the
# paddock — the first resume after a long pause is also when you find out about anything
# that rotted, and Thursday is when there is still time to care.
set -euo pipefail

# shellcheck source=_env.sh
. "$(cd "$(dirname "$0")" && pwd)/_env.sh"

ARN=$(aws apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${RPG_SERVICE_NAME}'].ServiceArn | [0]" --output text)
if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "No App Runner service named '${RPG_SERVICE_NAME}' found in ${AWS_REGION}." >&2
  exit 1
fi

echo "Resuming ${ARN}…"
aws apprunner resume-service --service-arn "$ARN" --query "Service.Status" --output text

URL=$(aws apprunner describe-service --service-arn "$ARN" --query "Service.ServiceUrl" --output text)
echo "Waiting for the service to answer…"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 5 "https://${URL}/admin/login"; then
    echo "Up: https://${URL}"
    exit 0
  fi
  sleep 5
done
echo "Service did not answer within 5 minutes — check the App Runner console." >&2
exit 1
