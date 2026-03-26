#!/bin/bash
# Apply patches to hoisted node_modules for mobile app compatibility
# These patches fix Abstraxion SDK issues for React Native (Treasury-sponsored transactions)

set -e
MONOREPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MONOREPO_ROOT"

echo "Applying patches..."

# Helper: try to apply a patch, skip silently if target files don't exist
apply_patch() {
  local patch_file="$1"
  local label="$2"

  if [ ! -f "$patch_file" ]; then
    return
  fi

  # Use --batch to prevent interactive prompts, --forward to skip already-applied
  if patch -p1 --batch --forward --dry-run < "$patch_file" > /dev/null 2>&1; then
    patch -p1 --batch --forward < "$patch_file" > /dev/null 2>&1 && \
      echo "  $label patch applied" || \
      echo "  $label patch failed"
  else
    echo "  $label patch already applied or not needed"
  fi
}

apply_patch "patches/@burnt-labs+signers+1.0.0-alpha.6.patch" "@burnt-labs/signers"
apply_patch "patches/@burnt-labs+abstraxion-core+1.0.0-alpha.67.patch" "@burnt-labs/abstraxion-core"
apply_patch "patches/@burnt-labs+abstraxion-react-native+1.0.0-alpha.16.patch" "@burnt-labs/abstraxion-react-native"

echo "Patches done."
