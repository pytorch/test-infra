set -eux
git cliff --tag "$1" > CHANGELOG.md
sed -i "s/^version.*/version = \"$1\"/" Cargo.toml
git commit -am "chore(release): prep for $1"
git tag "lintrunner/v$1"
git push
git push origin "lintrunner/v$1"
