The capabilities of what we can show for PRs on GitHub is very limited. Solutions have been posed in the past with Dr. CI, first as a separate page then as a GitHub comment. I’ve also developed some Chrome extensions to fill gaps in DevX but these haven’t had wide adoption since they’re hard to discover and require installation. Similar to [prow.k8s.io](http://prow.k8s.io/), we should have our own landing page for displaying anything and everything a PR developer needs.

GitHub’s API has a very low IP-based rate limit for unauthenticated requests, so we need some kind of GitHub sign in for this to work. Unfortunately GitHub does not host this themselves for you, so we need to stand up [an OAuth proxy server](https://github.com/prose/gatekeeper) to handle generating tokens while keeping our client secret a secret.

To deploy the server:

1. Provision an EC2 instance with Terraform

    ```bash
    terraform apply -var="key_name=<the key name>" -var="name=auth.pytorch.org"
    ```

2. Set up a file called `vars.yml` to contain a file path to: a SSL key, a SSL cert, the OAuth client ID, and the OAuth client secret.

3. Run the Ansible playbook to set up the server

    ```bash
    ansible-playbook -i ubuntu@<the instance name>, install.yml --extra-vars=@vars.yml --private-key=~/<the aws private key from step 1>
    ```