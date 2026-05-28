#!/usr/bin/env bash
# Apply vendored-content patches to content/ and mirror the result into
# data/ where the running server reads from. Idempotent: hunks already
# present are skipped via `patch --forward`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="$REPO_ROOT/patches"
CHECK_ONLY=0

usage() {
    cat <<EOF
usage: $(basename "$0") [--check] [PATCH...]

Apply every *.patch file in patches/ (or the named patches) against
the working tree. Patches are expected to target paths relative to
repo root with a leading 'a/' / 'b/' marker (i.e. \`patch -p1\` form).

Options:
  --check   Dry-run; report what would change but don't write.
EOF
}

while (( $# > 0 )); do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --check)   CHECK_ONLY=1; shift ;;
        --)        shift; break ;;
        -*)        usage; exit 2 ;;
        *)         break ;;
    esac
done

if (( $# == 0 )); then
    set -- "$PATCH_DIR"/*.patch
fi

cd "$REPO_ROOT"

extra=()
(( CHECK_ONLY )) && extra+=(--dry-run)

for p in "$@"; do
    [[ "$p" = /* ]] || p="$PATCH_DIR/$p"
    [[ -f "$p" ]] || { echo "skip: $p (not found)" >&2; continue; }
    echo "apply: $(basename "$p")"
    # --forward skips already-applied hunks rather than reverting them.
    # --reject-file rejects to /dev/null so a partial fail doesn't litter the tree.
    patch -p1 --forward --reject-file=- "${extra[@]}" < "$p" || {
        rc=$?
        # patch returns 1 when reverse-applies are detected (hunk
        # already in tree) — that's a successful no-op for us.
        if (( rc == 1 )); then
            echo "  (some hunks already applied — ok)"
        else
            echo "  patch failed with rc=$rc" >&2
            exit "$rc"
        fi
    }
done

# Mirror touched files from content/ to data/ so the running server picks
# up the change without waiting for a gameconverter run.
if (( ! CHECK_ONLY )); then
    for p in "$@"; do
        [[ "$p" = /* ]] || p="$PATCH_DIR/$p"
        [[ -f "$p" ]] || continue
        # Pull every `+++ b/content/...` target line, strip the `b/` prefix,
        # and copy content/X to data/X if a sibling data/ path exists.
        grep '^+++ b/content/' "$p" | sed 's|^+++ b/||' | while read -r src; do
            dst="${src/#content\//data/}"
            if [[ -f "$dst" ]]; then
                cp "$src" "$dst"
                echo "  mirror: $src -> $dst"
            fi
        done
    done
fi
