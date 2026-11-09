import unittest

import reflow


def line(text, x, y, w=0.36, h=0.025):
    return {"text": text, "x": x, "y": y, "w": w, "h": h}


class NeedsSpaceTest(unittest.TestCase):
    def test_word_broken_at_line_end_is_joined(self):
        self.assertFalse(reflow.needs_space("나쁜 말이 튀어나오는 점만 빼", "면 말이야."))
        self.assertFalse(reflow.needs_space("세상에서 가장 싫어하는 사람이 누구", "냐고 묻는다면"))

    def test_real_space_at_line_end_is_kept(self):
        self.assertTrue(reflow.needs_space("바보 멍청아!\" 하고", "욕을 했다가"))
        self.assertTrue(reflow.needs_space("도무지 이유를", "모르겠단 말이야."))

    def test_punctuation_rules(self):
        self.assertTrue(reflow.needs_space("코피가 터진 적도 있었고,", "좋아하는"))
        self.assertTrue(reflow.needs_space("고민할 필요도 없이,", "“만복이요!”"))
        self.assertFalse(reflow.needs_space("공주병 환자야.”", "라고 말해 버렸어."))


class ReflowTest(unittest.TestCase):
    def test_indent_starts_paragraph_and_page_number_is_dropped(self):
        lines = [
            line("가지, 입만 열면 저절로 나쁜 말이 튀어나오는 점만 빼", 0.08, 0.14),
            line("면 말이야.", 0.08, 0.19, w=0.06),
            line("아무도 만복이와 놀아 주지 않았고, 만복이만 나타", 0.10, 0.24),
            line("나면 친구들도 슬금슬금 자리를 피했어.", 0.08, 0.29),
            line("12", 0.08, 0.95, w=0.01),
        ]
        blocks = reflow.reflow(lines, aspect=1.44, spread=True)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["paragraphs"], [
            "가지, 입만 열면 저절로 나쁜 말이 튀어나오는 점만 빼면 말이야.",
            "아무도 만복이와 놀아 주지 않았고, 만복이만 나타나면 친구들도 슬금슬금 자리를 피했어.",
        ])

    def test_spread_reads_left_page_before_right_page(self):
        lines = [
            line("오른쪽 쪽의 글이에요.", 0.60, 0.10, w=0.30),
            line("왼쪽 쪽의 글이에요.", 0.08, 0.50, w=0.30),
        ]
        blocks = reflow.reflow(lines, aspect=1.44, spread=True)
        self.assertEqual([block["paragraphs"][0] for block in blocks], ["왼쪽 쪽의 글이에요.", "오른쪽 쪽의 글이에요."])

    def test_empty_page(self):
        self.assertEqual(reflow.reflow([line("  ", 0.1, 0.1)]), [])


if __name__ == "__main__":
    unittest.main()
