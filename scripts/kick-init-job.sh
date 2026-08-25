#!/usr/bin/env bash
# Run gw2-crafting-roi once, immediately, instead of waiting for the schedule —
# so a fresh deploy has craft_roi populated rather than an empty table until the
# next slot.
#
# Lives here rather than inline in .github/workflows/deploy.yml because that
# workflow is now a shim over dustfeather/shared-workflows' deploy-k8s.yml, and
# the shim passes this as `verify-command`. A shell string in a YAML input is a
# bad home for twenty lines with a polling loop in them.
#
# Called after the Postgres rollout wait, and a non-zero exit fails the deploy —
# which is the point: a deploy whose first run never completes has not been
# shown to work.
#
# Namespace: kubectl's default is already the target namespace when the shared
# workflow invokes this, so no -n here. Run it by hand with
# `kubectl config set-context --current --namespace=trading` first, or set
# NAMESPACE.
set -euo pipefail

NAMESPACE="${NAMESPACE:-}"
ns_args=()
[ -n "$NAMESPACE" ] && ns_args=(-n "$NAMESPACE")

JOB=gw2-roi-init
CRONJOB=gw2-crafting-roi
ATTEMPTS=240
INTERVAL=5

kubectl "${ns_args[@]}" delete job "$JOB" --ignore-not-found
kubectl "${ns_args[@]}" create job "$JOB" --from="cronjob/${CRONJOB}"

succeeded() {
  kubectl "${ns_args[@]}" get job "$JOB" -o jsonpath='{.status.succeeded}' 2>/dev/null || true
}

# Poll with `get` instead of `kubectl wait`: the CI Role (gw2-ci-deployer)
# grants get/list/create/delete on jobs but NOT watch, and `kubectl wait` opens
# a watch under the hood ("Failed to watch" spam).
#
# Wait on the Job's terminal CONDITION, never on `.status.failed`. The pod-level
# deadline makes a blown attempt an ordinary retryable pod failure, so
# `.status.failed` goes to 1 while the Job is still healthy and retrying —
# reading it as fatal would fail the deploy on a run that goes on to succeed.
# Only the `Failed` condition is terminal.
for _ in $(seq 1 "$ATTEMPTS"); do
  if [ "$(succeeded)" = "1" ]; then
    echo "init job complete"
    exit 0
  fi
  cond="$(kubectl "${ns_args[@]}" get job "$JOB" \
    -o jsonpath='{.status.conditions[?(@.status=="True")].type}' 2>/dev/null || true)"
  case "$cond" in
    *Failed*)
      echo "init job failed terminally"
      kubectl "${ns_args[@]}" get job "$JOB" -o wide
      exit 1
      ;;
  esac
  sleep "$INTERVAL"
done

echo "init job did not complete within $((ATTEMPTS * INTERVAL))s"
kubectl "${ns_args[@]}" get job "$JOB" -o wide
exit 1
