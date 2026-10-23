import unittest
from unittest.mock import Mock

import phonology_rules


class PhonologyRulesTest(unittest.TestCase):
    def test_batil_uses_verified_standard_pronunciation_override(self):
        g2p = Mock(side_effect=AssertionError("override must run before g2pkk"))

        result = phonology_rules.classify("밭일", g2p)

        self.assertEqual(result["발음"], "반닐")
        self.assertEqual(result["유형"], "ㄴ첨가")
        self.assertEqual(result["유형전체"], ["ㄴ첨가", "비음화"])
        self.assertEqual(result["조항"], ["29", "18"])
        self.assertTrue(result["신뢰"])
        g2p.assert_not_called()

    def test_batil_override_is_preserved_when_particle_is_attached(self):
        g2p = Mock(return_value="반니를")

        result = phonology_rules.classify("밭일을", g2p)

        self.assertEqual(result["발음"], "반니를")
        self.assertEqual(result["유형전체"], ["ㄴ첨가", "비음화"])
        self.assertTrue(result["신뢰"])
        g2p.assert_called_once_with("반닐을")


if __name__ == "__main__":
    unittest.main()
