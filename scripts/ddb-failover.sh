#!/usr/bin/env bash
#
# Manually point the API Lambda's DynamoDB traffic at another region.
#
#   ./scripts/ddb-failover.sh status              # where is it pointing now?
#   ./scripts/ddb-failover.sh failover            # -> replica region
#   ./scripts/ddb-failover.sh failback            # -> back to its own region
#   ./scripts/ddb-failover.sh failover ap-south-1 # explicit environment
#
# Global Tables are active-active, so there is no "promote" step: the replica
# already accepts writes. Failover is purely a client-side switch, which is all
# this script does.
#
# It MERGES the DDB_REGION variable into the existing environment. Calling
# `aws lambda update-function-configuration --environment` by hand REPLACES the
# whole map and would silently drop JWT_SECRET and everything else.
#
# This changes the Lambda only. Everything else (API Gateway, S3, SQS) stays in
# the primary region, so this covers a DynamoDB-only fault, NOT a full regional
# outage.

set -euo pipefail

ACTION="${1:-status}"
REGION="${2:-ap-south-1}"

CONFIG="$(dirname "$0")/../env.config.json"
[[ -f "$CONFIG" ]] || { echo "❌ env.config.json not found"; exit 1; }

ENTRY=$(jq -r --arg r "$REGION" '.[$r] // empty' "$CONFIG")
[[ -n "$ENTRY" ]] || { echo "❌ region $REGION is not in env.config.json"; exit 1; }

LABEL=$(jq -r '.label'        <<<"$ENTRY")
PROJECT=$(jq -r '.project'    <<<"$ENTRY")
REPLICA=$(jq -r '.replicaRegion' <<<"$ENTRY")
FN="${PROJECT}apigatewayhandler"

echo "$LABEL — $FN"
echo "primary=$REGION  replica=$REPLICA"
echo

current=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FN" \
            --query 'Environment.Variables.DDB_REGION' --output text 2>/dev/null || echo "None")
[[ "$current" == "None" || -z "$current" ]] && current=""

show_state() {
  if [[ -z "$current" ]]; then
    echo "  ▶ DynamoDB traffic: $REGION (primary — normal operation)"
  else
    echo "  ▶ DynamoDB traffic: $current (FAILED OVER)"
  fi
}

case "$ACTION" in
  status)
    show_state
    echo
    echo "  replica health:"
    aws dynamodb describe-table --region "$REGION" --table-name "${PROJECT}audit-logs" \
      --query 'Table.Replicas[].[RegionName,ReplicaStatus]' --output text 2>/dev/null \
      | sed 's/^/    /' || echo "    (no replica configured)"
    exit 0
    ;;
  failover) TARGET="$REPLICA" ;;
  failback) TARGET="" ;;
  *) echo "❌ unknown action: $ACTION (use status | failover | failback)"; exit 1 ;;
esac

show_state
if [[ "$current" == "$TARGET" ]]; then
  echo "  nothing to do — already in that state."
  exit 0
fi

if [[ -n "$TARGET" ]]; then
  # Refuse to send traffic to a replica that is not actually ready.
  st=$(aws dynamodb describe-table --region "$REGION" --table-name "${PROJECT}audit-logs" \
        --query "Table.Replicas[?RegionName=='$TARGET'].ReplicaStatus" --output text 2>/dev/null || echo "")
  if [[ "$st" != "ACTIVE" ]]; then
    echo "❌ replica in $TARGET is '${st:-absent}', not ACTIVE. Refusing to fail over."
    exit 1
  fi
  echo "  target: $TARGET (replica ACTIVE ✅)"
else
  echo "  target: $REGION (failback to primary)"
fi

read -r -p "  Apply to $FN? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "  aborted."; exit 0; }

# Merge, never replace: keep every existing variable, change only DDB_REGION.
MERGED=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FN" \
  --query 'Environment.Variables' --output json \
  | jq -c --arg v "$TARGET" '. + {DDB_REGION:$v}')

aws lambda update-function-configuration --region "$REGION" --function-name "$FN" \
  --environment "{\"Variables\":$MERGED}" >/dev/null

aws lambda wait function-updated --region "$REGION" --function-name "$FN"

now=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FN" \
        --query 'Environment.Variables.DDB_REGION' --output text)
echo "  ✅ applied — DDB_REGION='${now/None/}'"
echo
echo "  This is break-glass only — the next cdk deploy resets it. To make the"
echo "  switch durable, set activeDbRegion in env.config.json and deploy:"
echo
echo "      \"$REGION\": { ..., \"activeDbRegion\": \"${TARGET:-null}\" }"
