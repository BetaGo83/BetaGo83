#!/bin/bash
# 세션이 시작될 때마다 저장소의 git 훅 폴더(.githooks)를 켠다.
# 그 안의 pre-commit 훅이 커밋할 때마다 API 키가 섞였는지 검사한다.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"
git config core.hooksPath .githooks
