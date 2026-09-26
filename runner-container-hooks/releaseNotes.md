## Features

- Raise the per-attempt `cp{To,From}Pod` tar timeout from 120s to 300s. The copy cost scales with the workspace's file count: a workspace holding two full pytorch action trees (~47k files) takes ~108s on an idle node, leaving no headroom under 120s, so node contention timed out every attempt. Since each retry restarts the copy from zero, affected jobs never converged.

## SHA-256 Checksums

- docker: `<DOCKER_SHA>`
- k8s: `<K8S_SHA>`
