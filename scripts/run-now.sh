#!/usr/bin/env bash
# Manually trigger one bot run (instead of waiting for the hourly CronJob).
# Creates a one-off Job from the CronJob template, tails its logs, waits for
# completion, prints the resulting craft_roi row count, and (if .env is present)
# repushes the Grafana dashboard.
#
# Usage:  bash scripts/run-now.sh
# Env overrides: KCTX (kube context), NS (namespace), CRONJOB (cronjob name)
set -euo pipefail

KCTX="${KCTX:-k3s-itguys}"
NS="${NS:-trading}"
CRONJOB="${CRONJOB:-gw2-crafting-roi}"
K=(kubectl --context "$KCTX" -n "$NS")

JOB="gw2-roi-manual-$(date +%s)"
echo ">> creating job ${JOB} from cronjob/${CRONJOB}"
"${K[@]}" create job "$JOB" --from="cronjob/${CRONJOB}"

# Ensure the job (and its pods) are cleaned up on exit regardless of outcome.
cleanup() { "${K[@]}" delete job "$JOB" --ignore-not-found >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo ">> waiting for pod to start, then tailing logs"
# Poll until the pod leaves Pending/ContainerCreating (a short job may already be
# Running/Succeeded); logs -f then attaches cleanly instead of racing container create.
for _ in $(seq 1 60); do
  phase="$("${K[@]}" get pod -l "job-name=${JOB}" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)"
  [ "$phase" = "Running" ] || [ "$phase" = "Succeeded" ] || [ "$phase" = "Failed" ] && break
  sleep 2
done
"${K[@]}" logs -f "job/${JOB}" --pod-running-timeout=120s || true

echo ">> waiting for completion"
if "${K[@]}" wait --for=condition=complete "job/${JOB}" --timeout=600s; then
  echo ">> job complete"
else
  echo "!! job did not complete — status:"
  "${K[@]}" get "job/${JOB}" -o wide
  exit 1
fi

echo ">> craft_roi rows now:"
"${K[@]}" exec statefulset/gw2-postgres -- \
  psql -U gw2 -d gw2 -At -c \
  "SELECT count(*)||' rows, best ROI '||round(max(roi_pct)::numeric,1)||'%, updated '||max(updated_at) FROM craft_roi;" \
  || echo "   (could not query postgres)"

# Repush the dashboard so any k8s/grafana/dashboards/ change is reflected.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  echo ">> repushing Grafana dashboard"
  set -a; . "$SCRIPT_DIR/../.env"; set +a
  bash "$SCRIPT_DIR/provision-grafana.sh"
else
  echo ">> .env not found — skipping dashboard repush"
fi
