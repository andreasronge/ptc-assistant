#!/usr/bin/env bash
# Deploys the checkout's workflows and built google-mcp into
# $PTC_ASSISTANT_DATA/app/ and writes one project file per workflow beside it.
#
# ptc resolves project paths only beneath the project file's directory, and
# refuses absolute paths, `..`, and symlinked artifact layouts, so the app is
# copied rather than linked. The copy also pins what runs: editing the checkout
# changes nothing until the next deploy.
#
#   scripts/deploy.sh               # refuses a dirty checkout
#   scripts/deploy.sh --allow-dirty # for development only
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

allow_dirty=false
[[ "${1:-}" == "--allow-dirty" ]] && allow_dirty=true

commit=$(git -C "$repo" rev-parse HEAD)
dirty=false
[[ -z "$(git -C "$repo" status --porcelain)" ]] || dirty=true
if $dirty && ! $allow_dirty; then
  echo "deploy: the checkout has uncommitted changes; commit them or pass --allow-dirty" >&2
  exit 1
fi

(cd "$repo/google-mcp" && pnpm install --frozen-lockfile --silent && pnpm run --silent build)

with_lock
staging="$data/app.new"
rm -rf "$staging"
mkdir -p "$staging/google-mcp"
rsync -a "$repo/workflows" "$staging/"
rsync -a "$repo/google-mcp/"{package.json,dist,node_modules} "$staging/google-mcp/"
mkdir -p "$staging/google-mcp/test"
rsync -a "$repo/google-mcp/test/helpers" "$staging/google-mcp/test/"
jq -n --arg commit "$commit" --argjson dirty "$dirty" --arg at "$(date -u +%FT%TZ)" \
  '{commit: $commit, dirty: $dirty, deployed_at: $at}' >"$staging/DEPLOYED.json"

# Every workflow shares one artifact root, so the Viewer, REPL, and prune see
# every run. The fake host config is deployed too, for offline checks.
for manifest in "$staging"/workflows/*/ptc.json; do
  name=$(basename "$(dirname "$manifest")")
  jq -n --arg app "app/workflows/$name/ptc.json" '{
    kind: "ptc-project",
    version: 1,
    application: {path: $app},
    host: {path: "app/workflows/ptc-host.json"},
    artifacts: {root: "ptc", trace: true, inspection: true, result: false}
  }' >"$data/$name.ptc-project.json"
done

rm -rf "$data/app.old"
[[ -d "$data/app" ]] && mv "$data/app" "$data/app.old"
mv "$staging" "$data/app"
rm -rf "$data/app.old"
echo "deployed ${commit:0:8}$($dirty && echo ' (dirty)') to $data/app"
