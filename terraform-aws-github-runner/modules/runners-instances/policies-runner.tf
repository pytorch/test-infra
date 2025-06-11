data "aws_caller_identity" "current" {}

resource "aws_iam_role" "runner" {
  name                 = "${var.environment}-github-action-runners-runner-role"
  assume_role_policy   = templatefile("${path.module}/policies/instance-role-trust-policy.json", {})
  path                 = local.role_path
  permissions_boundary = var.role_permissions_boundary
  tags                 = local.tags
}

resource "aws_iam_instance_profile" "runner" {
  name = "${var.environment}-github-action-runners-profile"
  role = aws_iam_role.runner.name
  path = local.instance_profile_path
}

resource "aws_iam_role_policy_attachment" "runner_session_manager_aws_managed" {
  count      = var.enable_ssm_on_runners ? 1 : 0
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "ssm_parameters" {
  name = "runner-ssm-parameters"
  role = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-ssm-parameters-policy.json",
    {
      arn_ssm_parameters = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.environment}-*"
    }
  )
}

resource "aws_iam_role_policy" "dist_bucket" {
  name = "distribution-bucket"
  role = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-s3-policy.json",
    {
      s3_arn = var.s3_bucket_runner_binaries.arn
    }
  )
}

resource "aws_iam_role_policy_attachment" "managed_policies" {
  count      = length(var.runner_iam_role_managed_policy_arns)
  role       = aws_iam_role.runner.name
  policy_arn = element(var.runner_iam_role_managed_policy_arns, count.index)
}

// see also logging.tf for logging and metrics policies

resource "aws_iam_role_policy" "create_tags" {
  name   = "runner-create-tags"
  role   = aws_iam_role.runner.name
  policy = file("${path.module}/policies/instance-ec2-create-tags-policy.json")
}

# This policy is conditionally created only when runner_secrets_arns is provided.
# This ensures we don't create empty policies when no secret access is needed,
# making the security configuration more explicit and reducing IAM clutter.
resource "aws_iam_role_policy" "secrets_access" {
  count  = length(var.runner_secrets_arns) > 0 ? 1 : 0
  name   = "runner-secrets-access"
  role   = aws_iam_role.runner.name

  lifecycle {
    precondition {
      condition     = length(var.runner_secrets_arns) == 0 || length(var.runner_secrets_kms_key_arns) > 0
      error_message = "runner_secrets_kms_key_arns must be provided when runner_secrets_arns is specified. Each secret requires explicit KMS key permissions for decryption."
    }
  }

  policy = templatefile("${path.module}/policies/instance-secrets-policy.json",
    {
      # Automatically append wildcards to secret ARNs if they don't already have them
      # AWS Secrets Manager ARNs have a 6-character alphanumeric suffix starting with '-'
      # (e.g., "MySecret" becomes "MySecret-a1b2c3")
      # We use "-??????" to match the format exactly, which is more secure than "*"
      # This handles cases where users provide bare secret names or already-complete ARNs
      secrets_arns = jsonencode([
        for arn in var.runner_secrets_arns :
        # Skip transformation if ARN already ends with "*" or has the exact 6-char suffix
        endswith(arn, "*") || can(regex("-[a-zA-Z0-9]{6}$", arn)) ? arn : "${arn}-??????"
      ])
      # KMS key ARNs for decrypting the secrets - must be provided when secrets are specified
      kms_key_arns = jsonencode(var.runner_secrets_kms_key_arns)
      aws_region = var.aws_region
    }
  )
}
