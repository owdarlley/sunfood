#!/bin/sh
# ignoreCommand da Vercel: sai 0 para pular o build, 1 para fazer o build.
# Sem commit anterior, redeploy do mesmo commit ou erro do git (clone raso): faz o build.
p="$VERCEL_GIT_PREVIOUS_SHA"
[ -n "$p" ] && [ "$p" != "$VERCEL_GIT_COMMIT_SHA" ] || exit 1
git diff --quiet "$p" HEAD -- . 2>/dev/null && exit 0
exit 1
