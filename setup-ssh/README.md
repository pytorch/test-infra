# add-github-ssh-key

This actions adds the Github ssh keys found from `https://github.com/${{ github.actor }}.keys` and places them in `~/.ssh/authorized_keys` so that users can easily log into
Github Actions runners without having to go through the work of adding the keys manually.

# Usage

```yaml
- name: Enable SSH (Click me for details)
  uses: seemethere/add-github-ssh-key@v1.0.0
  with:
    github-secret: ${{ secrets.GITHUB_TOKEN }}
    activate-with-label: true
    label: with-ssh
- name: Hold runner for 30 minutes or until ssh sessions have drained
  timeout-minutes: 30
  run: |
    echo "Holding runner until all ssh sessions have logged out"
    while [[ "$(who)" != "" ]]; do
      echo "."
      sleep 5
    done
```

## Available parameters

- `GITHUB_TOKEN` (string, _required_): used to grab labels from the API as well as the public ssh keys
- `activate-with-label` (boolean): Whether or not to use labels as a limiting factor on when to add ssh keys
- `label` (string): Label to use in conjunction with `activate-with-label`

# Contributing

Dependencies can be installed using:

```bash
yarn install
```

Run build / tests / linters / formatters

```bash
yarn all
```
