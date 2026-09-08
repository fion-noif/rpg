# GitHub Actions → AWS, with no stored keys anywhere.
#
# The workflow (.github/workflows/deploy.yml) assumes this role via OIDC federation: GitHub
# signs a short-lived token naming the repo and branch, AWS verifies it against the trust
# condition below. A compromised GitHub account can therefore push an image to this one ECR
# repo — and nothing else. It cannot read a secret, touch the database, or reach the service.
# Deploys still happen because App Runner itself watches :latest (apprunner.tf), so the
# pipeline needs no App Runner permissions either.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates GitHub's cert chain itself these days; the thumbprint is retained because
  # the API still requires one. This is GitHub's published root thumbprint.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "github_deploy" {
  name = "rpg-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # main only: a PR branch cannot ship an image, so a deploy always corresponds to a
          # commit that actually landed.
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy_ecr" {
  name = "push-rpg-image"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken is account-scoped by the API; it cannot be narrowed further.
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = aws_ecr_repository.app.arn
      }
    ]
  })
}
