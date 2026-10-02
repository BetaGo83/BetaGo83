#!/usr/bin/env python3
"""커밋에 API 키가 섞여 들어가지 않았는지 검사한다.

git pre-commit 훅(.githooks/pre-commit)이 커밋할 때마다 실행한다. 아래가 보이면 커밋을 막는다.
- 환경 변수에 든 키 값 (DART_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)
- 인증키가 그대로 박힌 DART API 주소 (crtfc_key 뒤에 키 값)
- 키를 담는 .env 파일
찾은 키 값은 화면에 출력하지 않고, 파일 이름과 줄 번호만 알려 준다.

    python3 scripts/check_secrets.py          # 커밋하려고 올려 둔(스테이징된) 파일 검사
    python3 scripts/check_secrets.py --all    # 저장소의 모든 파일 검사
"""

import os
import re
import subprocess
import sys

SECRET_ENV_VARS = ("DART_API_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET")
MIN_SECRET_LENGTH = 8
KEY_IN_URL = re.compile(r"crtfc_key=[A-Za-z0-9]{20,}")
ENV_FILE = re.compile(r"(^|/)\.env(\.[^/]+)?$")


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def split_paths(output):
    return [path for path in output.decode("utf-8").split("\0") if path]


def files_to_check(scan_all):
    """(경로, 내용) 쌍을 돌려준다. 기본은 스테이징된 내용, --all이면 작업 폴더의 파일."""
    if scan_all:
        for path in split_paths(git("ls-files", "-z")):
            try:
                with open(path, "rb") as f:
                    yield path, f.read()
            except (FileNotFoundError, IsADirectoryError):
                continue
    else:
        for path in split_paths(git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")):
            yield path, git("show", f":{path}")


def main():
    scan_all = "--all" in sys.argv[1:]
    secrets = [
        (name, value)
        for name in SECRET_ENV_VARS
        if len(value := os.environ.get(name, "").strip()) >= MIN_SECRET_LENGTH
    ]

    problems = []
    for path, content in files_to_check(scan_all):
        if ENV_FILE.search(path):
            problems.append(f"{path}: 키를 담는 .env 파일은 올리지 않습니다")
        for line_no, line in enumerate(content.decode("utf-8", errors="replace").splitlines(), 1):
            for name, value in secrets:
                if value in line:
                    problems.append(f"{path}:{line_no}: {name} 값이 들어 있습니다")
            if KEY_IN_URL.search(line):
                problems.append(f"{path}:{line_no}: DART API 주소에 인증키(crtfc_key)가 들어 있습니다")

    if problems:
        print("API 키가 섞여 있어서 커밋을 막았습니다.", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print("키를 지우고 환경 변수에서 읽도록 고친 다음 다시 커밋하세요.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
