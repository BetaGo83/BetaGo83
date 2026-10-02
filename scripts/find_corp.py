#!/usr/bin/env python3
"""DART에 등록된 회사 이름으로 고유번호(corp_code)와 종목코드를 찾는다.

DART 회사 목록(corpCode.xml)을 raw/.cache/에 한 번 받아 두고 다시 쓴다(7일 지나면 새로 받음).

    python3 scripts/find_corp.py 한미반도체 SK하이닉스
"""

import os
import struct
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zlib

from wiki_common import RAW, hide_secrets

CACHE = RAW / ".cache" / "corpCode.xml"


def download():
    """회사 목록 zip을 받아 XML로 푼다.

    클라우드 프록시가 느려 중간에 끊기면 받은 데까지만 풀어 이번 실행에만 쓰고, 캐시는 남기지 않는다.
    돌려주는 값: XML 바이트. 다 받았을 때만 raw/.cache/corpCode.xml에 저장한다.
    """
    key = os.environ.get("DART_API_KEY", "").strip()
    if not key:
        sys.exit("DART_API_KEY 환경 변수가 없습니다. Claude 클라우드 환경 설정의 환경 변수에 넣어 주세요.")
    data, complete = bytearray(), True
    try:
        url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={key}"
        with urllib.request.urlopen(url, timeout=60) as response:
            while chunk := response.read(65536):
                data += chunk
    except Exception as error:
        complete = False
        print(f"[주의] 회사 목록을 끝까지 받지 못해 받은 부분만 씁니다: {hide_secrets(error)}", file=sys.stderr)
    if data[:4] != b"PK\x03\x04":
        sys.exit(f"DART가 회사 목록 대신 다른 응답을 보냈습니다: {hide_secrets(bytes(data[:200]).decode('utf-8', 'replace'))}")
    name_len, extra_len = struct.unpack("<HH", data[26:30])
    try:
        xml = zlib.decompressobj(-15).decompress(bytes(data[30 + name_len + extra_len:]))
    except zlib.error as error:
        sys.exit(f"회사 목록 압축을 풀지 못했습니다: {error}")
    end = xml.rfind(b"</list>")
    if end < 0:
        sys.exit("회사 목록이 너무 조금 받아져 쓸 수 없습니다. 잠시 뒤 다시 실행하세요.")
    xml = xml[: end + len(b"</list>")]
    if not xml.rstrip().endswith(b"</result>"):
        xml += b"\n</result>"
    if complete:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_bytes(xml)
    else:
        print("[주의] 일부 회사가 빠져 '없음'으로 나올 수 있습니다.", file=sys.stderr)
    return xml


def load():
    if CACHE.exists() and time.time() - CACHE.stat().st_mtime <= 7 * 86400:
        try:
            root = ET.parse(CACHE).getroot()
        except ET.ParseError:
            CACHE.unlink()  # 깨진 캐시는 지우고 새로 받는다
            root = ET.fromstring(download())
    else:
        root = ET.fromstring(download())
    return [{child.tag: (child.text or "").strip() for child in item} for item in root.iter("list")]


def main():
    corps = load()
    for name in sys.argv[1:]:
        exact = [c for c in corps if c["corp_name"] == name]
        # 상장사를 먼저 보이고 10개까지 (잘라내기 전에 정렬해야 상장사가 빠지지 않는다)
        found = sorted(exact or [c for c in corps if name in c["corp_name"]], key=lambda c: not c["stock_code"])[:10]
        for c in found or [{"corp_name": f"{name}: 없음", "corp_code": "", "stock_code": ""}]:
            print(f"{c['corp_name']}\tcorp_code={c['corp_code']}\tstock_code={c['stock_code']}")


if __name__ == "__main__":
    main()
