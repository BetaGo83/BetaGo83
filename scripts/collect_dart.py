#!/usr/bin/env python3
"""DART 오픈API에서 공시를 모아 raw/dart/오늘.jsonl에 더한다.

모으는 공시
- 상장사(코스피·코스닥)의 주요 사건 공시: 공급계약, 출자·지분 취득, 시설투자, 합병·분할, 실적 등
- 위키에 페이지가 있는 기업(dart_corp_code)의 공시: 지분 보고서 같은 잡음을 뺀 전부
사건 공시는 원문을 내려받아 계약 상대, 금액 같은 핵심 항목을 뽑아 둔다.
이미 모은 공시(같은 rcept_no)는 건너뛴다.

키는 환경 변수 DART_API_KEY에서 읽는다. 저장·출력하는 링크는 공시 뷰어 주소만 쓴다.

    python3 scripts/collect_dart.py             # 이어서 받기: 지난번에 받은 마지막 날부터 오늘까지 (처음이면 최근 7일)
    python3 scripts/collect_dart.py --days 3    # 최근 3일만 (이어서 받기 기록은 빈 날이 생기지 않을 때만 앞으로 옮긴다)

어디까지 받았는지는 raw/dart/covered.json에 적는다. 목록 조회는 90일씩 나눠서 한다(DART 제한).
"""

import argparse
import html
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

from wiki_common import RAW, append_jsonl, hide_secrets, pages, read_jsonl

KST = timezone(timedelta(hours=9))
API = "https://opendart.fss.or.kr/api"
VIEWER = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="
COVERED = RAW / "dart" / "covered.json"
WINDOW_DAYS = 90  # 회사 지정 없이 목록을 조회할 때 한 번에 받을 수 있는 기간

# 상장사 전체에서 모으는 사건 공시 (보고서 이름에 들어 있는 말)
EVENT_REPORTS = (
    "단일판매ㆍ공급계약", "단일판매·공급계약", "공급계약체결",
    "타법인주식및출자증권취득", "타법인주식및출자증권처분",
    "신규시설투자", "유형자산취득", "유형자산양수",
    "회사합병", "회사분할", "영업양수", "영업양도", "주식교환", "주식이전",
    "최대주주변경을수반하는주식양수도", "주식양수도계약",
    "투자판단관련주요경영사항", "기술도입", "기술이전",
    "영업(잠정)실적", "매출액또는손익구조",
)
# 페이지가 있는 기업이어도 건너뛰는 공시
NOISE_REPORTS = (
    "주식등의대량보유상황보고서", "임원ㆍ주요주주특정증권등", "주주명부폐쇄", "기업지배구조",
    "의결권대리행사", "자기주식취득결과", "자기주식처분결과", "신탁계약", "증권발행실적",
    "일괄신고추가서류", "투자설명서", "주권매매거래정지", "전환가액", "공정거래자율준수",
)
# 원문에서 뽑는 핵심 항목 (표의 이름 칸에 들어 있는 말)
KEY_LABELS = (
    "계약명", "체결계약명", "판매ㆍ공급계약 내용", "판매·공급계약 내용", "세부내용", "계약금액", "최근매출액",
    "매출액대비", "계약상대", "계약기간", "시작일", "종료일", "계약(수주)일자", "공급지역",
    "회사명", "발행회사", "취득주식수", "취득금액", "취득후 소유", "지분비율", "취득목적",
    "처분주식수", "처분금액", "투자구분", "투자금액", "투자목적", "자산구분", "취득가액",
    "합병방법", "합병상대", "합병목적", "분할방법", "제목", "주요내용", "양수도", "양수인", "양도인",
    "매출액", "영업이익", "당기순이익",
)
CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def api_get(path, params):
    key = os.environ.get("DART_API_KEY", "").strip()
    if not key:
        sys.exit("DART_API_KEY 환경 변수가 없습니다. Claude 클라우드 환경 설정의 환경 변수에 넣어 주세요.")
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API}/{path}?crtfc_key={key}&{query}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except Exception as error:
            if attempt == 2:
                raise RuntimeError(hide_secrets(error)) from None
            time.sleep(2 ** attempt)


def list_filings_window(begin, end):
    rows, page = [], 1
    while True:
        data = json.loads(api_get("list.json", {
            "bgn_de": begin, "end_de": end, "page_no": page, "page_count": 100,
        }))
        if data.get("status") == "013":  # 조회된 데이터 없음
            return rows
        if data.get("status") != "000":
            raise RuntimeError(f"DART 오류 {data.get('status')}: {data.get('message')}")
        rows.extend(data["list"])
        if page >= data["total_page"]:
            return rows
        page += 1


def list_filings(begin, end):
    """begin~end(날짜) 공시 목록. 90일보다 길면 나눠서 받는다."""
    rows, start = [], begin
    while start <= end:
        stop = min(end, start + timedelta(days=WINDOW_DAYS - 1))
        rows.extend(list_filings_window(start.strftime("%Y%m%d"), stop.strftime("%Y%m%d")))
        start = stop + timedelta(days=1)
    return rows


def read_covered():
    """이어서 받기 기록: 이 날짜까지는 빠짐없이 받았다."""
    try:
        return datetime.strptime(json.loads(COVERED.read_text(encoding="utf-8"))["through"], "%Y-%m-%d").date()
    except (FileNotFoundError, KeyError, ValueError):
        return None


def clean(text):
    text = re.sub(r"<br[^>]*>", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", html.unescape(TAG.sub("", text))).strip()


def key_items(rcept_no):
    """공시 원문 표에서 핵심 항목을 {이름: 값}으로 뽑는다."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(api_get("document.xml", {"rcept_no": rcept_no})))
    except Exception as error:
        return {"_오류": hide_secrets(error)[:200]}
    items = {}
    for name in archive.namelist():
        text = archive.read(name).decode("utf-8", errors="replace")
        for row in ROW.findall(text):
            cells = [clean(cell) for cell in CELL.findall(row)]
            cells = [cell for cell in cells if cell and cell != "-"]
            if len(cells) < 2:
                continue
            label, value = " ".join(cells[:-1]), cells[-1]
            if any(word in label for word in KEY_LABELS) and len(label) <= 60:
                items.setdefault(label[:60], value[:200])
            if len(items) >= 25:
                return items
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int)
    args = parser.parse_args()

    today = datetime.now(KST).date()
    seen = {row["rcept_no"] for row in read_jsonl("dart")}
    covered = read_covered()
    if covered is None:  # 기록이 없으면 이미 받은 파일 중 가장 늦은 날부터
        done = sorted(path.stem for path in (RAW / "dart").glob("*.jsonl"))
        covered = datetime.strptime(done[-1], "%Y-%m-%d").date() if done else None
    if args.days:
        begin = today - timedelta(days=args.days - 1)
    else:
        # 마지막 날은 그날 늦게 나온 공시가 있을 수 있어 다시 받는다 (rcept_no로 중복을 거른다)
        begin = covered if covered else today - timedelta(days=6)

    tracked = {meta.get("dart_corp_code") for _, _, meta, _ in pages("companies")} - {None, ""}
    try:
        filings = list_filings(begin, today)
    except Exception as error:
        sys.exit(f"공시 목록을 받지 못했습니다: {hide_secrets(error)}")

    new_rows = []
    for filing in filings:
        name = re.sub(r"\s+", "", filing["report_nm"])
        if filing["rcept_no"] in seen or any(word in name for word in NOISE_REPORTS):
            continue
        is_event = filing["corp_cls"] in ("Y", "K") and any(word in name for word in EVENT_REPORTS)
        if not (is_event or filing["corp_code"] in tracked):
            continue
        seen.add(filing["rcept_no"])
        row = {
            "rcept_no": filing["rcept_no"],
            "corp_name": filing["corp_name"],
            "corp_code": filing["corp_code"],
            "stock_code": filing["stock_code"],
            "corp_cls": filing["corp_cls"],
            "report_nm": re.sub(r"\s+", " ", filing["report_nm"]).strip(),
            "rcept_dt": f"{filing['rcept_dt'][:4]}-{filing['rcept_dt'][4:6]}-{filing['rcept_dt'][6:]}",
            "url": VIEWER + filing["rcept_no"],
        }
        if is_event:
            row["items"] = key_items(filing["rcept_no"])
        new_rows.append(row)

    new_rows.sort(key=lambda row: row["rcept_no"])
    # 빈 날 없이 이어질 때만 '여기까지 받았다' 기록을 오늘로 옮긴다
    if covered is None or begin <= covered + timedelta(days=1):
        COVERED.write_text(json.dumps({"through": today.isoformat()}) + "\n", encoding="utf-8")
    else:
        print(f"[주의] {covered + timedelta(days=1)}~{begin - timedelta(days=1)} 공시를 아직 받지 않았습니다. "
              "--days 없이 실행하면 이어서 받습니다.", file=sys.stderr)
    if new_rows:
        path = append_jsonl("dart", today.isoformat(), new_rows)
        print(f"{begin}~{today} 공시 {len(filings)}건 중 새로 모은 것 {len(new_rows)}건 -> raw/dart/{path.name}")
    else:
        print(f"{begin}~{today} 새 공시 없음")


if __name__ == "__main__":
    main()
