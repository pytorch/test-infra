output "runners" {
  value = {
    launch_template_name_linux      = module.runners.launch_template_linux.name
    launch_template_id_linux        = module.runners.launch_template_linux.id
    launch_template_version_linux   = module.runners.launch_template_linux.latest_version
    launch_template_name_windows    = module.runners.launch_template_windows.name
    launch_template_id_windows      = module.runners.launch_template_windows.id
    launch_template_version_windows = module.runners.launch_template_windows.latest_version
    lambda_up                       = module.runners.lambda_scale_up
    lambda_down                     = module.runners.lambda_scale_down
    role_runner                     = module.runners.role_runner
    role_scale_up                   = module.runners.role_scale_up
    role_scale_down                 = module.runners.role_scale_down
  }
}

output "binaries_syncer" {
  value = {
    lambda      = module.runner_binaries.lambda
    lambda_role = module.runner_binaries.lambda_role
    location    = local.s3_action_runner_url
  }
}

output "webhook" {
  value = {
    gateway     = module.webhook.gateway
    lambda      = module.webhook.lambda
    lambda_role = module.webhook.role
    endpoint    = "${module.webhook.gateway.api_endpoint}/${module.webhook.endpoint_relative_path}"
  }
}
