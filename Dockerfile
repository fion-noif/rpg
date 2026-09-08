# The whole app as one container: migrate, then serve. Built by .github/workflows/deploy.yml,
# run by AWS App Runner (infra/apprunner.tf), and runnable locally against the compose db —
# see docs/deploy.md.
#
# Deliberately a full-fat image (complete node_modules) rather than Next's standalone output.
# Standalone traces only what the *app* imports, and the entrypoint also has to run
# src/scripts/migrate.ts through tsx — a devDependency standalone would drop. The price is
# image size, which App Runner does not bill for; the win is that the container runs exactly
# what `npm ci && npm run build` produced, with no second dependency graph to reason about.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# No .env and no database at build time, on purpose: every page is force-dynamic, so nothing
# prerenders against data, and src/config.ts defers its requireEnv() reads until first use.
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Amazon RDS certificate bundle (all regions), so DATABASE_URL can say `sslmode=require` and
# node's TLS stack can actually *verify* the server rather than being told not to look.
# NODE_EXTRA_CA_CERTS extends trust; it does not replace the default store, so QuickBooks'
# public certificates keep verifying too. Harmless locally, where the URL carries no sslmode.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts ./
# The runtime needs src/ and db/ for exactly one job: `npm run db:migrate` reads
# db/schema.sql (idempotent by design — see that file) through src/scripts/migrate.ts.
COPY --from=build /app/src ./src
COPY --from=build /app/db ./db
COPY docker-entrypoint.sh ./

RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["sh", "docker-entrypoint.sh"]
