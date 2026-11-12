"""사전 발음 사전(lexicon): 규칙으로는 계산할 수 없는 낱말 발음을 국립국어원 사전에서 가져온다.

표준발음법 규칙(g2pkk + 자체 보정)은 받침·연음·비음화처럼 소리 환경으로 정해지는
변동을 잘 계산하지만, 다음은 낱말마다 정해져 있어 규칙만으로는 알 수 없다.

- 사잇소리 된소리(제28항·30항): 나물국[나물꾹], 하늘색[하늘쌕], 달빛[달삗]
- 한자어 된소리(제26항): 출정식[출쩡식], 철자법[철짜뻡], 학술적[학쑬쩍]
- ㄴ 첨가(제29항): 집안일[지반닐], 가랑잎[가랑닙]
- 한자어 ㄴ+ㄹ(제20항 다만): 판단력[판단녁]

그래서 한국어기초사전 표제어 중 "규칙 결과와 사전 발음이 다른" 낱말만 모아 둔다.
어절이 이 낱말로 시작하면 사전 발음을 쓰고, 뒤에 붙은 조사·어미는 규칙으로 잇는다.
화면 카드에는 근거로 사전 표제어 번호를 함께 낸다.

빌드(한 번):
    ../.venv/bin/python pronunciation_lexicon.py --build
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path

from pronunciation_variants import same

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "data" / "dict" / "krdict.sqlite3"
LEXICON = ROOT / "data" / "pronunciation_lexicon.json"
HANGUL = re.compile(r"^[가-힣]+$")
NOUN_POS = {"명사", "의존 명사", "대명사", "수사", "부사"}
VERB_POS = {"동사", "형용사"}
# 어절 = 사전 낱말 + 조사·어미. 이보다 긴 꼬리는 다른 낱말이 붙은 합성어일 수 있어 쓰지 않는다.
MAX_SUFFIX = 4
# 꼬리는 조사·어미이거나 '하다/되다'가 붙은 꼴이어야 한다. 그 밖의 꼬리(눈가+림, 장기+적)는
# 다른 낱말이나 접미사일 수 있어 사전 발음을 쓰지 않는다.
_JOSA = (
    "이|가|은|는|을|를|의|에|에서|에게|께|와|과|도|만|로|으로|랑|이랑|하고|부터|까지|보다|처럼|마다|조차|밖에|"
    "이나|나|이며|며|이다|입니다|이에요|예요|이었다|였다|이라|라|이라고|라고|인|일|임|이고|고|에는|에도|으로는|로는|과는|와는|에서는|까지는|부터는|만큼|뿐"
)
TAIL = re.compile(rf"^(?:(?:{_JOSA})+|[하한할함합해했되된될됨됩돼됐][가-힣]{{0,3}})$")
_g2p = None


def _init():
    global _g2p
    from g2pkk import G2p

    _g2p = G2p()


def _candidate(row):
    """(표기, 사전 발음, 표제어 번호, 품사) → 규칙과 다르면 사전 항목을 돌려준다."""
    lemma, raw, entry_id, pos = row
    prons = [p.replace("-", "").replace("^", "").strip() for p in (raw or "").split("/") if p.strip()]
    if not prons or not HANGUL.match(lemma) or not all(HANGUL.match(p) for p in prons):
        return None
    key, pron = lemma, prons[0]
    if pos in VERB_POS:
        # 동사·형용사는 어간만 쓴다. 어간 끝 음절이 사전 발음에서 그대로일 때만 쓸 수 있다
        # (읽다[익따]처럼 어간 받침이 바뀌면 어미에 따라 소리가 달라지므로 규칙에 맡긴다).
        if len(lemma) < 3 or len(pron) != len(lemma) or not lemma.endswith("다"):
            return None
        key, pron = lemma[:-1], pron[:-1]
        if key[-1] != pron[-1]:
            return None
    elif pos not in NOUN_POS or len(lemma) < 2:
        return None
    rule = _g2p(key)
    regular = any(same(rule, p) for p in ([pron] if pos in VERB_POS else prons))
    # 규칙으로 맞히는 낱말도 돌려줘서, 같은 표기의 다른 동형어와 발음이 갈리는지 본다.
    return key, {"발음": pron, "entry_id": entry_id, "품사": pos, "_regular": regular}


def build(database: Path = DATABASE, output: Path = LEXICON, workers: int = 8) -> dict:
    with sqlite3.connect(database) as db:
        rows = db.execute(
            "SELECT lemma, pronunciation, entry_id, part_of_speech FROM entries "
            "WHERE pronunciation IS NOT NULL AND pronunciation != ''"
        ).fetchall()
    with Pool(workers, initializer=_init) as pool:
        found = [item for item in pool.map(_candidate, rows, chunksize=300) if item]
    by_key: dict[str, list[dict]] = {}
    for key, value in found:
        by_key.setdefault(key, []).append(value)
    lexicon: dict[str, dict] = {}
    conflicts = set()
    for key, values in by_key.items():
        irregular = [v for v in values if not v["_regular"]]
        if not irregular:
            continue
        # 동형어끼리 발음이 다르면(장기 長期[장기]·將棋[장끼]) 문맥 없이 정할 수 없어 규칙에 맡긴다.
        if any(not same(v["발음"], irregular[0]["발음"]) for v in values):
            conflicts.add(key)
            continue
        lexicon[key] = {k: irregular[0][k] for k in ("발음", "entry_id", "품사")}
    payload = {
        "source": "국립국어원 한국어기초사전 (표제어 발음)",
        "note": "규칙(g2pkk+자체 보정) 결과와 사전 발음이 다른 표제어만 담는다. 동형어 발음 충돌은 제외.",
        "entries": dict(sorted(lexicon.items())),
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8")
    return {"rows": len(rows), "lexicon": len(lexicon), "conflicts_dropped": len(conflicts)}


@lru_cache(maxsize=1)
def _load() -> dict:
    if not LEXICON.is_file():
        return {}
    return json.loads(LEXICON.read_text(encoding="utf-8"))["entries"]


def lookup(word: str):
    """어절 앞부분과 맞는 가장 긴 사전 낱말을 찾는다. (낱말, 항목, 꼬리) 또는 None."""
    entries = _load()
    for end in range(len(word), 1, -1):
        head, tail = word[:end], word[end:]
        if len(tail) > MAX_SUFFIX:
            break
        item = entries.get(head)
        if item and (not tail or TAIL.match(tail)):
            return head, item, tail
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="사전 발음 사전을 만듭니다.")
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()
    if args.build:
        print(json.dumps(build(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
