"""Deterministic Mandarin ASR matching; never replaces authored caption spelling."""
import difflib
from pypinyin import lazy_pinyin


def normalized(text):
    return ''.join(c for c in text if c.isalnum())


def compare_speech(authored, recognized):
    authored, recognized = normalized(authored), normalized(recognized)
    # One token per character retains the recognized word-to-time mapping.
    units = lambda text: lazy_pinyin(text, errors=lambda chars: list(chars.lower()))
    left, right = units(authored), units(recognized)
    if len(left) != len(authored) or len(right) != len(recognized):
        raise ValueError('Unexpected ASR phoneme mapping length')
    matcher = difflib.SequenceMatcher(None, left, right, autojunk=False)
    matched = {i for block in matcher.get_matching_blocks() for i in range(block.a, block.a + block.size)}
    return matcher, {
        'match_method': 'mandarin_pinyin_no_tone',
        'similarity': round(matcher.ratio(), 3),
        'text_similarity': round(difflib.SequenceMatcher(None, authored, recognized, autojunk=False).ratio(), 3),
        'coverage': round(len(matched) / max(1, len(authored)), 3),
        'tail_matched': bool(authored) and all(i in matched for i in range(max(0, len(authored) - 4), len(authored))),
    }
