# Deploying to AWS

One container on **App Runner**, one **Aurora Serverless v2** Postgres that scales to zero,
secrets in **SSM Parameter Store**, images in **ECR** pushed by GitHub Actions over OIDC.
Everything is defined in `infra/`; nothing is clicked together in the console.

The design answers three requirements, in order of importance:

1. **The data cannot be lost.** Three independent backup layers (§ Backups).
2. **Pause for weeks between races.** `infra/scripts/pause.sh`; paused cost ≈ $5/mo (§ Pause).
3. **Easy updates.** Push to `main` → image builds → App Runner deploys itself (§ Updating).

Two deliberate calls to know about before touching anything:

- **The database has a public endpoint** with TLS forced and an RDS-managed password. The
  header of `infra/aurora.tf` carries the full reasoning (short version: private networking
  forces an always-on ~$32/mo NAT through App Runner's VPC connector, which breaks the pause
  budget, and it would strand the laptop that runs backups and `npm run auth`). Narrow
  `db_ingress_cidrs` in `infra/variables.tf` to known networks once you know them.
- **Never point an uptime pinger at the app.** Every route touches the database, so any
  periodic HTTP check keeps Aurora awake forever and quietly reinstates the 24/7 bill. App
  Runner's own health check is TCP for exactly this reason (`infra/apprunner.tf`).

## Prerequisites (operator laptop)

- AWS CLI, `terraform >= 1.9`, `docker`
- `pg_dump`/`pg_restore` 16+: `brew install libpq && brew link --force libpq`

### Credentials

Terraform and the operator scripts authenticate as the dedicated **`rpg`** IAM user under the
`rpg` CLI profile:

```sh
aws configure --profile rpg     # access key for the rpg user; region us-west-2
AWS_PROFILE=rpg aws sts get-caller-identity   # expect .../user/rpg
```

`rpg` carries `AdministratorAccess`. That is deliberate, not a shortcut: this stack creates
four IAM roles (`infra/github-oidc.tf`, `apprunner.tf`, `s3-backups.tf`), so it needs
`iam:CreateRole` + `iam:PutRolePolicy` + `iam:PassRole` regardless — and any principal holding
those three can grant itself admin in one step. A hand-scoped policy containing them would be
admin-equivalent with extra maintenance. Give the user **programmatic access only**; no
console password.

The profile name is pinned in `infra/variables.tf` (`var.aws_profile`) rather than inherited
from the shell, so an apply cannot quietly run against whichever profile happened to be
default. `infra/scripts/_env.sh` pins the same profile *and* `AWS_REGION` for the scripts.
Both are defaults — a second operator overrides with `-var aws_profile=…` / `AWS_PROFILE=…`.

Everything below assumes:

```sh
export AWS_PROFILE=rpg
export AWS_REGION=us-west-2     # the laptop's default profile may point elsewhere
```

**If a key is ever exposed**, AWS attaches `AWSCompromisedKeyQuarantineV2` to the user, whose
explicit `Deny` beats `AdministratorAccess` — applies fail on `iam:CreateRole` with "explicit
deny in an identity-based policy" while unrelated calls still succeed, which is a confusing
symptom if you don't know the cause. Delete the key, work the auto-filed AWS Support case to
find the leak, check Billing and CloudTrail for abuse, then detach the quarantine policy.

## First deploy

Order matters twice: the image must exist before App Runner is created, and the database
must exist before its URL can be stored. Both are one `-target` bootstrap each.

```sh
cd infra
terraform init

# 1. Registry + CI trust first, so an image can exist.
terraform apply -target=aws_ecr_repository.app \
                -target=aws_iam_openid_connect_provider.github \
                -target=aws_iam_role.github_deploy \
                -target=aws_iam_role_policy.github_deploy_ecr

# 2. Wire GitHub: set repo variables AWS_DEPLOY_ROLE_ARN, AWS_ECR_REPOSITORY, AWS_REGION
#    (values from `terraform output`), then push main or run the workflow manually.
#    Wait for the green run — ECR now has :latest.

# 3. Database next, so its endpoint exists.
terraform apply -target=aws_rds_cluster_instance.main   # ~10 minutes; pulls in the cluster/VPC

# 4. Secrets. Terraform made the parameter names; the values never pass through it.
PW=$(aws secretsmanager get-secret-value \
      --secret-id "$(terraform output -raw db_master_secret_arn)" \
      --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')
EP=$(terraform output -raw db_endpoint)
aws ssm put-parameter --overwrite --name /rpg/database-url --type SecureString \
  --value "postgres://racing:${PW}@${EP}:5432/racing?sslmode=require"
aws ssm put-parameter --overwrite --name /rpg/qbo-client-id     --type SecureString --value '<from developer.intuit.com>'
aws ssm put-parameter --overwrite --name /rpg/qbo-client-secret --type SecureString --value '<from developer.intuit.com>'
aws ssm put-parameter --overwrite --name /rpg/admin-secret      --type SecureString --value "$(openssl rand -base64 24)"
unset PW

# 5. Everything else — App Runner comes up against real secrets.
terraform apply

# 6. Close the loop on magic links: the service URL only exists now.
terraform apply -var "app_base_url=$(terraform output -raw service_url)"
```

(If the ordering is ever botched, it fails soft: the entrypoint detects a placeholder
`DATABASE_URL`, skips the migration, and serves an erroring app instead of crash-looping the
service creation. Fix the secret, trigger a deployment, done.)

Then bootstrap the application itself, from the laptop against the production DB — the same
commands as local setup, pointed at the public endpoint.

**Every node script run from the laptop needs the RDS CA bundle.** The stored DATABASE_URL
says `sslmode=require`, which node-pg treats as *verified* TLS (unlike libpq, where require
means encrypt-only — `pg_dump` in backup.sh needs nothing). RDS certificates chain to
Amazon's own CA, not the public trust store, so without the bundle every script below fails
with `self-signed certificate in certificate chain`. The container has it baked in
(Dockerfile); the laptop downloads it once:

```sh
curl -so ~/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export NODE_EXTRA_CA_CERTS=~/rds-global-bundle.pem

DB_URL=$(aws ssm get-parameter --name /rpg/database-url --with-decryption --query Parameter.Value --output text)
DATABASE_URL=$DB_URL npm run create-admin -- <username> "<Full Name>" --owner
DATABASE_URL=$DB_URL npm run auth     # QBO OAuth; tokens land in the qbo_tokens table
DATABASE_URL=$DB_URL npm run sync
```

Sign in at `<service_url>/admin/login`, create the event, print links. Note the QBO app's
registered redirect URI stays `http://localhost:8355/callback` — the OAuth dance runs on the
laptop; only the resulting tokens live in the (remote) database.

### Demo data on the deployed system

`npm run seed-demo` works against production the same way — it is just another laptop script
pointed at the remote DB. It needs the bootstrap above already done (admin id 1, QBO tokens,
a sync), the CA bundle exported, and one extra variable: **APP_BASE_URL**, because the magic
links it prints embed whatever base URL the process sees, and links are shown exactly once.

```sh
APP_BASE_URL=$(cd infra && terraform output -raw service_url) \
DATABASE_URL=$DB_URL npm run seed-demo          # add -- --reset to rebuild it
```

It refuses to run unless `QBO_ENVIRONMENT=sandbox` — it posts a real demo invoice through
the real posting path, so after the flip to production this command is supposed to fail.
Clean the demo weekend out before real use with `--reset` (or the truncate in the README).

## Updating

Push to `main`. The workflow builds and pushes `:latest` + `:<sha>`; App Runner sees the new
`:latest` and deploys (migration runs on boot — `db/schema.sql` is replay-safe by
construction). **Rollback:** retag a previous sha and App Runner redeploys it:

```sh
REPO=$(cd infra && terraform output -raw ecr_repository_url)
MANIFEST=$(aws ecr batch-get-image --repository-name rpg --image-ids imageTag=<good-sha> \
  --query 'images[0].imageManifest' --output text)
aws ecr put-image --repository-name rpg --image-tag latest --image-manifest "$MANIFEST"
```

Config changes (env vars, instance size, ingress CIDRs) are Terraform edits + `apply`.

## Pause and resume

```sh
infra/scripts/pause.sh    # fresh backup to S3 first, then pauses App Runner
infra/scripts/resume.sh   # resumes and waits until the app answers
```

Aurora is not in either script because it manages itself: min capacity 0 means it suspends
~30 minutes after the last query and resumes on the next one (~15 s, paid once by whoever
opens the site Thursday before the race). Run `resume.sh` the day *before* a weekend — the
first resume after a long pause is when anything rotten surfaces, and Thursday leaves time
to care. Worker links from past events are dead during a pause anyway: link expiry derives
from event end dates.

Roughly: paused ≈ **$5/mo** (Aurora storage + S3 + ECR), an active month ≈ **$40–60**
(App Runner ~$50/mo prorated by uptime + Aurora ACU-hours while awake).

## Backups — three layers, because they fail differently

| Layer | Mechanism | Answers | RPO | Horizon |
|---|---|---|---|---|
| 1 | Aurora continuous PITR (automatic) | "undo the last bad write" | ~5 min | 35 days |
| 2 | S3 dump bucket, versioned | "what did the DB say in March" | per dump | years |
| 3 | Cross-region replica of that bucket | "the region/primary copies are gone" | minutes after upload | years |

Layer 2/3 dumps come from `infra/scripts/backup.sh` — run it after every race weekend;
`pause.sh` runs it unconditionally, so mothballing the system is what archives its final
state. Deletes deliberately do **not** replicate to the second region.

**A backup that has never been restored is a hope.** `infra/scripts/restore-drill.sh` pulls
the newest dump, restores it into a throwaway local container, and prints the row counts of
the tables that matter. Run it after the first real backup, then before each season.

The truly irreplaceable tables are `submissions`, `submission_lines`, `admin_actions`,
`events`, `workers`, `charge_batches` — billing history and audit trail. `customers`/`items`
re-sync from QuickBooks, and posted invoices live in QuickBooks itself.

## Secrets

No `.env` exists in production. The four true secrets are SSM SecureStrings injected by App
Runner; plain config (`QBO_ENVIRONMENT`, `APP_BASE_URL`, `EVENT_TIME_ZONE`) is reviewable
Terraform. To rotate one:

```sh
aws ssm put-parameter --overwrite --name /rpg/admin-secret --type SecureString --value '<new>'
aws apprunner start-deployment --service-arn "$(cd infra && terraform output -raw service_arn)"
```

(Secrets are read at deployment, not live.) Rotating `admin-secret` signs out every admin —
documented behavior, sometimes the point.

## Later

- **Custom domain:** ask the team managing `rolisonperformancegroup.com` for one CNAME
  (`parts.…` → the App Runner domain), add an `aws_apprunner_custom_domain_association`,
  update `app_base_url`. Until then the default `*.awsapprunner.com` URL is fine — it is
  stable across pause/resume and deploys, and changes only if the service is destroyed.
- **QBO production:** flip `qbo_environment` in a reviewed Terraform change, put the
  production client id/secret into SSM, re-run `npm run auth` against the production company.
- **Hardening:** narrow `db_ingress_cidrs`; if the posture ever needs to change wholesale,
  the private-subnets + VPC-connector + NAT path is written up in `infra/aurora.tf`.
- **Scaling past one instance** is an application change first: the login throttle is
  in-process and the migration runs on boot (`infra/apprunner.tf` pins max_size=1 on purpose).
