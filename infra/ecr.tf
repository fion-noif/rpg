# Image registry. The GitHub workflow pushes :latest plus a :<git-sha> tag per build;
# App Runner watches :latest (auto_deployments_enabled), so "deploy" is "push to main"
# and "roll back" is retagging a previous sha as latest.

resource "aws_ecr_repository" "app" {
  name                 = "rpg"
  image_tag_mutability = "MUTABLE" # :latest must move; the immutable audit trail is the sha tags

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep the last 10 images: enough history to roll back a bad weekend's worth of deploys,
# without paying to store every build forever.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
