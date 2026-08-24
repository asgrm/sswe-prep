#!/usr/bin/env bash
# Step 3: Post each finding from a findings JSON file as an inline PR comment.
#
# WHY: Inline comments at the exact file and line provide actionable feedback
# in context. Generic PR-level comments get ignored. This is only possible
# because step 2 made the output structured (file/line/severity/message).
#
# Usage: post-inline-comments.sh [findings.json]
# Required env:
#   GH_TOKEN    - token with pull-request write access (gh CLI reads this)
#   REPO        - owner/name, e.g. acme/widgets
#   PR_NUMBER   - pull request number
#   COMMIT_SHA  - head commit SHA of the PR (comments anchor to a commit)
set -euo pipefail

FINDINGS_FILE="${1:-findings.json}"

jq -c '.findings[]' "$FINDINGS_FILE" | while read -r finding; do
  file=$(jq -r '.file' <<<"$finding")
  line=$(jq -r '.line' <<<"$finding")
  severity=$(jq -r '.severity' <<<"$finding")
  message=$(jq -r '.message' <<<"$finding")

  echo "Posting: $file:$line [$severity] $message"

  # POST /repos/{owner}/{repo}/pulls/{pr}/comments creates a review comment
  # anchored to a file + line on the RIGHT (new) side of the diff.
  gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
    -f body="**[$severity]** $message" \
    -f path="$file" \
    -F line="$line" \
    -f side=RIGHT \
    -f commit_id="$COMMIT_SHA" \
    || echo "::warning::Could not post inline comment for $file:$line (the line may not be part of this PR's diff)"
done
