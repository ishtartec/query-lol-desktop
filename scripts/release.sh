#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.2.0"
  exit 1
fi

VERSION="$1"
TAG="v$VERSION"

# Check we're on main
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "Error: must be on main branch (currently on $BRANCH)"
  exit 1
fi

# Check clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Check tag doesn't exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

echo "Bumping version to $VERSION..."

# Update package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json

# Update tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

# Update Cargo.toml (only the package version, not dependency versions)
sed -i '' "/^\[package\]/,/^\[/ s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

# Update Cargo.lock
(cd src-tauri && cargo check --quiet 2>/dev/null || true)

echo "Committing and tagging..."

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "release: v$VERSION"
git tag -a "$TAG" -m "v$VERSION"

echo "Pushing..."
git push origin main --follow-tags

echo ""
echo "Done! Release $TAG pushed."
echo "GitHub Actions will build and create the release at:"
echo "https://github.com/ishtartec/query-lol-desktop/releases/tag/$TAG"
