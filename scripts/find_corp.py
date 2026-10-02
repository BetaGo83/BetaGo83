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
    """회사 목록 zip을 받아 XML로 푼다. 클라우드 프록시가 느려 중간에 끊기면 받은 데까지만 푼다."""
    key = os.environ.get("DART_API_KEY", "").strip()
    data = bytearray()
    try:
        url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={key}"
        with urllib.request.urlopen(url, timeout=60) as response:
            while chunk := response.read(65536):
                data += chunk
    except Exception as error:
        print(f"[주의] 회사 목록을 끝까지 받지 못해 받은 부분만 씁니다: {hide_secrets(error)}", file=sys.stderr)
    name_len, extra_len = struct.unpack("<HH", data[26:30])
    xml = zlib.decompressobj(-15).decompress(bytes(data[30 + name_len + extra_len:]))
    xml = xml[: xml.rfind(b"</list>") + len(b"</list>")]
    if not xml.rstrip().endswith(b"</result>"):
        xml += b"\n</result>"
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(xml)


def load():
    if not CACHE.exists() or time.time() - CACHE.stat().st_mtime > 7 * 86400:
        download()
    return [
        {child.tag: (child.text or "").strip() for child in item}
        for item in ET.parse(CACHE).getroot().iter("list")
    ]


def main():
    corps = load()
    for name in sys.argv[1:]:
        exact = [c for c in corps if c["corp_name"] == name]
        found = exact or [c for c in corps if name in c["corp_name"]][:10]
        found.sort(key=lambda c: not c["stock_code"])
        for c in found or [{"corp_name": f"{name}: 없음", "corp_code": "", "stock_code": ""}]:
            print(f"{c['corp_name']}\tcorp_code={c['corp_code']}\tstock_code={c['stock_code']}")


if __name__ == "__main__":
    main()
