variable "lambdas" {
  description = "Name and tag for lambdas to download."
  type = list(object({
    name = string
    tag  = string
  }))
}
