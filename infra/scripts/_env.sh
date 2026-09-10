# Shared AWS defaults for the operator scripts. Sourced, never executed.
#
# Pinned for the same reason terraform pins its provider profile (see var.aws_profile in
# infra/variables.tf): these scripts pause the live service and read production dumps, and
# "it ran against the wrong account" is not a mistake the output makes obvious.
#
# AWS_REGION matters as much as the profile here. The operator laptop's default profile may
# well be configured for another region, and pause.sh/resume.sh find the service by listing
# App Runner *in the current region* — so a wrong region reports "no App Runner service named
# 'rpg' found", which reads like the service is gone rather than like a misconfigured shell.
#
# Both are defaults, not overrides: export either before running a script to point it
# elsewhere (the restore drill against a scratch account, a second operator's profile name).
export AWS_PROFILE="${AWS_PROFILE:-rpg}"
export AWS_REGION="${AWS_REGION:-us-west-2}" # keep in sync with var.region (infra/variables.tf)

# pause.sh/resume.sh locate the service by name. Not "rpg": App Runner enforces a
# 4-character minimum, so the service alone carries a longer name than the rest of the
# stack. Keep in sync with var.service_name (infra/variables.tf).
export RPG_SERVICE_NAME="${RPG_SERVICE_NAME:-rpg-app}"
