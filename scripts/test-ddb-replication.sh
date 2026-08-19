#!/usr/bin/env bash
#
# Verify DynamoDB Global Table replication between QA's primary and its replica.
#
#   ./scripts/test-ddb-replication.sh [table] [primary-region] [replica-region]
#   defaults: temple2-EventTable  ap-south-1  ap-southeast-1
#
# Defaults to temple2-EventTable because it holds 0 items — the canary writes
# below cannot disturb real data. Every item written is deleted at the end.
#
# Read-after-write ACROSS regions is eventually consistent by design, so the
# latency tests poll until the item appears instead of reading once.

set -uo pipefail

TABLE="${1:-temple2-EventTable}"
PRIMARY="${2:-ap-south-1}"
REPLICA="${3:-ap-southeast-1}"
ID="repltest-$(date +%s)-$$"

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
hdr()  { echo; echo "── $1"; }

cleanup() {
  aws dynamodb delete-item --region "$PRIMARY" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"$ID\"}}" >/dev/null 2>&1
  aws dynamodb delete-item --region "$PRIMARY" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"${ID}-reverse\"}}" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

echo "Table=$TABLE  primary=$PRIMARY  replica=$REPLICA"

# ── 1. Pre-flight: is this actually a global table? ──────────────────────────
hdr "1. Configuration"
DESC=$(aws dynamodb describe-table --region "$PRIMARY" --table-name "$TABLE" 2>/dev/null)
[ -z "$DESC" ] && { echo "Cannot describe $TABLE in $PRIMARY — is it deployed?"; exit 1; }

echo "$DESC" | grep -q '"StreamEnabled": true' \
  && ok "streams enabled (required for replication)" \
  || bad "streams NOT enabled — replication cannot work"

echo "$DESC" | grep -q "$REPLICA" \
  && ok "replica $REPLICA listed on the table" \
  || bad "no replica in $REPLICA"

RSTATUS=$(aws dynamodb describe-table --region "$PRIMARY" --table-name "$TABLE" \
  --query "Table.Replicas[?RegionName=='$REPLICA'].ReplicaStatus" --output text 2>/dev/null)
[ "$RSTATUS" = "ACTIVE" ] && ok "replica status ACTIVE" || bad "replica status: ${RSTATUS:-none} (ACTIVE expected)"

PITR=$(aws dynamodb describe-continuous-backups --region "$PRIMARY" --table-name "$TABLE" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
  --output text 2>/dev/null)
[ "$PITR" = "ENABLED" ] && ok "PITR enabled" || bad "PITR is ${PITR:-unknown}"

GSI_P=$(aws dynamodb describe-table --region "$PRIMARY" --table-name "$TABLE" \
  --query 'length(Table.GlobalSecondaryIndexes)' --output text 2>/dev/null)
GSI_R=$(aws dynamodb describe-table --region "$REPLICA" --table-name "$TABLE" \
  --query 'length(Table.GlobalSecondaryIndexes)' --output text 2>/dev/null)
[ "$GSI_P" = "$GSI_R" ] && ok "GSIs match across regions ($GSI_P each)" \
                        || bad "GSI mismatch: primary=$GSI_P replica=$GSI_R"

# Stop here if the table is not actually replicating. Without this the script
# writes a canary item and then polls a non-existent replica for 30s per test —
# noise that hides the one thing that matters: replication is not set up yet.
if [ "$fail" -gt 0 ]; then
  echo
  echo "──────────── configuration incomplete — skipping the live tests ────────────"
  echo "Nothing was written, so there is nothing to clean up."
  echo
  echo "Expected if you have not deployed yet. To set it up:"
  echo "  1) npx cdk deploy                        # PITR + streams (flags false)"
  echo "  2) set REPLICATE_QA=true in .env.local"
  echo "  3) npx cdk deploy                        # adds the ap-southeast-1 replica"
  echo "  4) re-run this script"
  exit 1
fi

# ── 2. Forward replication + how long it takes ───────────────────────────────
hdr "2. $PRIMARY ➜ $REPLICA (write, then poll the replica)"
aws dynamodb put-item --region "$PRIMARY" --table-name "$TABLE" --item "{
  \"id\":{\"S\":\"$ID\"},\"type\":{\"S\":\"repl-test\"},
  \"note\":{\"S\":\"written in $PRIMARY\"},\"date\":{\"S\":\"$(date +%F)\"}
}" >/dev/null 2>&1 || { bad "write to $PRIMARY failed"; exit 1; }
ok "wrote item $ID to $PRIMARY"

START=$(date +%s%N)
FOUND=""
for i in $(seq 1 60); do            # up to ~30s
  FOUND=$(aws dynamodb get-item --region "$REPLICA" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"$ID\"}}" --consistent-read \
    --query 'Item.id.S' --output text 2>/dev/null)
  [ "$FOUND" = "$ID" ] && break
  sleep 0.5
done
if [ "$FOUND" = "$ID" ]; then
  MS=$(( ($(date +%s%N) - START) / 1000000 ))
  ok "replicated to $REPLICA in ~${MS} ms"
else
  bad "item never appeared in $REPLICA within 30s"
fi

# ── 3. Reverse direction (global tables are multi-active) ────────────────────
hdr "3. $REPLICA ➜ $PRIMARY (reverse)"
RID="${ID}-reverse"
aws dynamodb put-item --region "$REPLICA" --table-name "$TABLE" --item "{
  \"id\":{\"S\":\"$RID\"},\"type\":{\"S\":\"repl-test\"},
  \"note\":{\"S\":\"written in $REPLICA\"}
}" >/dev/null 2>&1 && ok "wrote $RID to $REPLICA" || bad "write to $REPLICA failed"

BACK=""
for i in $(seq 1 60); do
  BACK=$(aws dynamodb get-item --region "$PRIMARY" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"$RID\"}}" --consistent-read \
    --query 'Item.id.S' --output text 2>/dev/null)
  [ "$BACK" = "$RID" ] && break
  sleep 0.5
done
[ "$BACK" = "$RID" ] && ok "replicated back to $PRIMARY" || bad "reverse replication failed"

# ── 4. Update + delete must propagate too ────────────────────────────────────
hdr "4. Update & delete propagation"
aws dynamodb update-item --region "$PRIMARY" --table-name "$TABLE" \
  --key "{\"id\":{\"S\":\"$ID\"}}" \
  --update-expression "SET note = :n" \
  --expression-attribute-values '{":n":{"S":"UPDATED"}}' >/dev/null 2>&1
UPD=""
for i in $(seq 1 60); do
  UPD=$(aws dynamodb get-item --region "$REPLICA" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"$ID\"}}" --consistent-read \
    --query 'Item.note.S' --output text 2>/dev/null)
  [ "$UPD" = "UPDATED" ] && break
  sleep 0.5
done
[ "$UPD" = "UPDATED" ] && ok "update propagated" || bad "update did not propagate (saw: ${UPD:-none})"

aws dynamodb delete-item --region "$PRIMARY" --table-name "$TABLE" \
  --key "{\"id\":{\"S\":\"$ID\"}}" >/dev/null 2>&1
GONE="present"
for i in $(seq 1 60); do
  R=$(aws dynamodb get-item --region "$REPLICA" --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"$ID\"}}" --consistent-read --output text 2>/dev/null)
  [ -z "$R" ] && { GONE="gone"; break; }
  sleep 0.5
done
[ "$GONE" = "gone" ] && ok "delete propagated (this is why PITR matters — deletes replicate too)" \
                     || bad "delete did not propagate"

# ── 5. The app's own access pattern via a GSI ────────────────────────────────
hdr "5. GSI query on the replica"
aws dynamodb query --region "$REPLICA" --table-name "$TABLE" --index-name type-index \
  --key-condition-expression "#t = :t" \
  --expression-attribute-names '{"#t":"type"}' \
  --expression-attribute-values '{":t":{"S":"repl-test"}}' \
  --query 'Count' --output text >/dev/null 2>&1 \
  && ok "type-index is queryable in $REPLICA" || bad "GSI query failed in $REPLICA"

echo; echo "──────────── $pass passed, $fail failed ────────────"
[ "$fail" -eq 0 ] || exit 1
