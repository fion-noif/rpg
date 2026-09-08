#!/bin/sh
# Migrate, then serve. Running the migration here rather than as a separate deploy step works
# because db/schema.sql is replay-safe by construction (every statement is IF NOT EXISTS or
# guarded — see its header) and because App Runner runs a single instance, so there is no
# rolling-deploy window where old code talks to a new schema's leftovers. Revisit both
# assumptions before ever scaling past one instance.
set -e

# Bootstrap forgiveness, and only bootstrap: on the very first `terraform apply` the SSM
# parameters still hold their CHANGE-ME placeholders, and a crash-looping migration would
# fail App Runner's health check and abort the service creation itself. So the placeholder
# skips the migration and serves anyway (pages will error until the secrets are set and a
# deployment triggered — docs/deploy.md). Any *real* migration failure still crashes loudly:
# serving traffic against a half-migrated schema is worse than not serving.
if [ "${DATABASE_URL:-}" = "CHANGE-ME" ]; then
  echo "DATABASE_URL is the CHANGE-ME placeholder — skipping migration; set the SSM secrets" \
       "and trigger a deployment (see docs/deploy.md)."
else
  echo "Applying db/schema.sql…"
  npm run db:migrate
fi

# exec so node is PID 1 and receives App Runner's SIGTERM directly instead of it dying in an
# npm wrapper process. `next start` honors PORT (App Runner sets it; defaults to 3000).
echo "Starting Next.js…"
exec node_modules/.bin/next start
