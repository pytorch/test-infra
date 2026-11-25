variable "skip_create_ami" {
  type    = bool
  default = true
}

# Tags the builder instance and its volume so a cancelled or failed CI run can
# find and remove what it launched (see build-windows-ami.yml). Local builds
# keep the default.
variable "run_id" {
  type    = string
  default = "local"
}
