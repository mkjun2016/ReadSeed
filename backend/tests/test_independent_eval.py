import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_pronunciation_benchmark as bench
import evaluate_krdict
import gloss_labeling
import pronunciation_lexicon
from pronunciation_variants import canonical, same


class VariantTest(unittest.TestCase):
    def test_standard_allows_these_variants(self):
        self.assertTrue(same("되푸리되니", "뒈푸리뒈니"))  # 제4항 붙임
        self.assertTrue(same("서끼어", "서끼여"))  # 제22항
        self.assertTrue(same("부릐한", "부리한"))  # 제5항 다만 4
        self.assertTrue(same("시계", "시게"))  # 제5항 다만 2

    def test_real_differences_stay_different(self):
        self.assertFalse(same("나물구기", "나물꾸기"))
        self.assertFalse(same("가치", "가티"))
        self.assertEqual(canonical("예의"), canonical("예이"))


class BenchmarkTest(unittest.TestCase):
    def test_headword_and_inflected_forms_become_cases(self):
        entry = {
            "val": "77517",
            "Lemma": {"feat": {"att": "writtenForm", "val": "첨탑"}},
            "feat": [{"att": "partOfSpeech", "val": "명사"}, {"att": "vocabularyLevel", "val": "고급"}],
            "WordForm": [
                {"feat": [{"att": "type", "val": "발음"}, {"att": "pronunciation", "val": "첨탑"}]},
                {"feat": [{"att": "type", "val": "활용"}, {"att": "writtenForm", "val": "첨탑이"}, {"att": "pronunciation", "val": "첨타비"}]},
                {"feat": [{"att": "type", "val": "활용"}, {"att": "writtenForm", "val": "첨탑만"}, {"att": "pronunciation", "val": "첨탐만"}]},
            ],
        }
        cases = {c["surface"]: c for c in bench.entry_cases(entry)}
        self.assertEqual(cases["첨탑"]["accepted"], ["첨탑"])
        self.assertEqual(cases["첨탑이"]["accepted"], ["첨타비"])
        self.assertEqual(cases["첨탑만"]["kind"], "활용")
        self.assertEqual(cases["첨탑이"]["source"], "krdict:77517")

    def test_scoring_counts_wrong_display_as_false_positive_and_accepts_variants(self):
        cases = [
            {"surface": "굳이", "accepted": ["구지"], "kind": "발음"},
            {"surface": "나물국이", "accepted": ["나물꾸기"], "kind": "활용"},
            {"surface": "되니", "accepted": ["뒈니"], "kind": "활용"},
            {"surface": "학교", "accepted": ["학꾜"], "kind": "발음"},
        ]
        preds = [
            {"발음": "구지", "다름": True, "신뢰": True, "유형": "구개음화"},
            {"발음": "나물구기", "다름": True, "신뢰": True, "유형": "연음"},
            {"발음": "되니", "다름": False, "신뢰": True, "유형": "동일"},
            {"발음": "학교", "다름": False, "신뢰": False, "유형": "미확인"},
        ]
        r = evaluate_krdict.score(cases, preds)
        self.assertEqual(r["false_positive"], 1)  # 나물국이
        self.assertEqual(r["false_negative"], 1)  # 학교 (needed, not shown)
        self.assertEqual(r["true_negative"], 1)  # 되니: [되니]도 표준 발음
        self.assertAlmostEqual(r["precision"], 0.5)


class LexiconTest(unittest.TestCase):
    def test_longest_dictionary_word_with_short_tail(self):
        fake = {"나물국": {"발음": "나물꾹", "entry_id": "1"}, "달빛": {"발음": "달삗", "entry_id": "2"}}
        with patch.object(pronunciation_lexicon, "_load", return_value=fake):
            self.assertEqual(pronunciation_lexicon.lookup("나물국이")[0], "나물국")
            self.assertIsNone(pronunciation_lexicon.lookup("학교에"))
            self.assertIsNone(pronunciation_lexicon.lookup("달빛가득한하늘에서"))  # 꼬리가 길면 합성어일 수 있다

    def test_tail_restores_the_spelled_final_consonant(self):
        from g2pkk import G2p

        import phonology_rules

        fake = {"달빛": {"발음": "달삗", "entry_id": "2"}}
        with patch.object(pronunciation_lexicon, "_load", return_value=fake):
            result = phonology_rules.classify("달빛이", G2p())
        self.assertEqual(result["발음"], "달삐치")
        self.assertEqual(result["근거"]["entry_id"], "2")
        self.assertEqual(result["유형"], "경음화")


class GlossKappaTest(unittest.TestCase):
    def test_cohen_kappa_and_merge_need_agreement_or_adjudication(self):
        self.assertAlmostEqual(gloss_labeling.cohen_kappa(["1", "2", "1", "0"], ["1", "2", "1", "0"]), 1.0)
        self.assertLess(gloss_labeling.cohen_kappa(["1", "1", "2", "2"], ["1", "2", "1", "2"]), 0.01)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            items = [
                {"item_id": "G001", "sentence": "계약을 해지했다.", "word": "해지", "pos": "NNG", "source": "s1",
                 "candidates": [{"local_id": "1:1", "뜻풀이": "끝냄", "동형어번호": "0", "난이도": "고급"}, {"local_id": "2:1", "뜻풀이": "해가 짐", "동형어번호": "0", "난이도": "고급"}]},
                {"item_id": "G002", "sentence": "조사를 했다.", "word": "조사", "pos": "NNG", "source": "s2",
                 "candidates": [{"local_id": "3:1", "뜻풀이": "살펴봄", "동형어번호": "0", "난이도": "고급"}, {"local_id": "4:1", "뜻풀이": "조문", "동형어번호": "0", "난이도": "고급"}]},
            ]
            (tmp / "items.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
            for name, labels in (("a.csv", ["1", "1"]), ("b.csv", ["1", "2"]), ("adj.csv", ["", ""])):
                with (tmp / name).open("w", encoding="utf-8-sig", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["item_id", "label"])
                    w.writerows([["G001", labels[0]], ["G002", labels[1]]])
            gold = tmp / "gold.json"
            added = gloss_labeling.merge(tmp / "adj.csv", tmp / "a.csv", tmp / "b.csv", tmp / "items.json", gold)
            self.assertEqual(added, 1)  # G002는 판정 근거가 없어 넣지 않는다
            saved = json.loads(gold.read_text(encoding="utf-8"))
            self.assertEqual(saved[0]["expected_local_id"], "1:1")
            self.assertEqual(saved[0]["basis"]["labelers"], 2)


if __name__ == "__main__":
    unittest.main()
