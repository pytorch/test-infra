set -e

ldd ./clang-tidy | grep -q "not a dynamic executable"
