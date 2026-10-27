import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/ecommerce'))
from speech import compare_speech


class MandarinSpeechTests(unittest.TestCase):
    def test_homophones_and_traditional_characters_do_not_reject_complete_speech(self):
        _, metrics = compare_speech('这是开学给你买的，这款菱格针织开衫，难怪你同学会看上。',
                                    '這是開學給你買的，這款零格真之開山，難怪你同學會看上。')
        self.assertGreaterEqual(metrics['similarity'], 0.9)
        self.assertGreaterEqual(metrics['coverage'], 0.9)
        self.assertTrue(metrics['tail_matched'])
        self.assertLess(metrics['text_similarity'], metrics['similarity'])

    def test_missing_payoff_is_not_hidden_by_phonetic_tolerance(self):
        _, metrics = compare_speech('我早上随便搭条白色长裤就可以出门上学了，穿搭挺省事的。',
                                    '我早上随便搭条白色长裤就可以出门上学了。')
        self.assertFalse(metrics['tail_matched'])
        self.assertLess(metrics['coverage'], 0.9)

    def test_different_product_claim_does_not_match(self):
        _, metrics = compare_speech('领口一排扣子，菱格花纹清楚，袖口也是收口的。', '这件衣服百分之百纯棉，保证防水。')
        self.assertLess(metrics['similarity'], 0.8)

    def test_non_chinese_tokens_keep_the_alignment_character_count(self):
        matcher, metrics = compare_speech('ABC130有货', 'abc130有貨')
        self.assertEqual(metrics['coverage'], 1)
        self.assertTrue(metrics['tail_matched'])
        self.assertEqual(matcher.get_matching_blocks()[0].size, 8)


if __name__ == '__main__':
    unittest.main()
