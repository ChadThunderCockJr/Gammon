#!/bin/bash
# Apply patches to hoisted node_modules for mobile app compatibility
# These patches fix Abstraxion SDK issues for React Native (Treasury-sponsored transactions)

set -e
MONOREPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MONOREPO_ROOT"

# Helper: check installed package version against expected patch version
check_version() {
  local pkg_dir="$1"
  local expected_version="$2"
  local pkg_name="$3"

  if [ -d "$pkg_dir" ]; then
    local installed_version
    installed_version=$(node -p "require('${pkg_dir}/package.json').version" 2>/dev/null || echo "unknown")
    if [ "$installed_version" != "$expected_version" ]; then
      echo "  WARNING: ${pkg_name} installed=${installed_version} but patch targets ${expected_version}"
    fi
  fi
}

echo "Applying patches..."

# Apply signers patch
if [ -f patches/@burnt-labs+signers+1.0.0-alpha.6.patch ]; then
  check_version "node_modules/@burnt-labs/signers" "1.0.0-alpha.6" "@burnt-labs/signers"
  patch -p1 -N --dry-run < patches/@burnt-labs+signers+1.0.0-alpha.6.patch > /dev/null 2>&1 && \
    patch -p1 -N < patches/@burnt-labs+signers+1.0.0-alpha.6.patch && \
    echo "  @burnt-labs/signers patch applied" || \
    echo "  @burnt-labs/signers patch already applied or not needed"
fi

# Apply abstraxion-core patch
if [ -f patches/@burnt-labs+abstraxion-core+1.0.0-alpha.67.patch ]; then
  check_version "node_modules/@burnt-labs/abstraxion-core" "1.0.0-alpha.67" "@burnt-labs/abstraxion-core"
  patch -p1 -N --dry-run < patches/@burnt-labs+abstraxion-core+1.0.0-alpha.67.patch > /dev/null 2>&1 && \
    patch -p1 -N < patches/@burnt-labs+abstraxion-core+1.0.0-alpha.67.patch && \
    echo "  @burnt-labs/abstraxion-core patch applied" || \
    echo "  @burnt-labs/abstraxion-core patch already applied or not needed"
fi

# Apply abstraxion-react-native patch (prevent re-initialization after logout)
if [ -f patches/@burnt-labs+abstraxion-react-native+1.0.0-alpha.16.patch ]; then
  check_version "node_modules/@burnt-labs/abstraxion-react-native" "1.0.0-alpha.16" "@burnt-labs/abstraxion-react-native"
  patch -p1 -N --dry-run < patches/@burnt-labs+abstraxion-react-native+1.0.0-alpha.16.patch > /dev/null 2>&1 && \
    patch -p1 -N < patches/@burnt-labs+abstraxion-react-native+1.0.0-alpha.16.patch && \
    echo "  @burnt-labs/abstraxion-react-native patch applied" || \
    echo "  @burnt-labs/abstraxion-react-native patch already applied or not needed"
fi

echo "Patches done."
