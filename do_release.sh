set -eux
git cliff --tag "$1"
git commit -am "chore(release): prep for $1"
git tag "$1"
git push
git push origin "$1"
