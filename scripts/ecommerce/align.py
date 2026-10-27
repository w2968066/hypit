"""Finite local ASR alignment; outputs draft timings for review, never claimed approval."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from faster_whisper import WhisperModel
from speech import normalized, compare_speech


def clauses(text):
    result = []
    for part in re.split(r'[，。！？；,!?;]', text):
        part = part.strip()
        while part:
            cut = min(14, len(part))
            if len(part) > 14:
                boundaries = [m.start() for m in re.finditer(r'就可以|就能|然后|而且|但是|所以|也能', part) if 6 <= m.start() <= 14]
                if boundaries:
                    cut = boundaries[-1]
            chunk = part[:cut]
            if result and len(normalized(result[-1])) < 4 and len(normalized(result[-1] + chunk)) <= 14:
                result[-1] += '，' + chunk
            else:
                result.append(chunk)
            part = part[cut:]
    return result


def main():
    source, destination = map(Path, sys.argv[1:3])
    request = json.loads(source.read_text(encoding='utf-8-sig'))
    model = WhisperModel(os.environ.get('HYPIT_ECOMMERCE_ASR_MODEL', 'base'), device='cpu', compute_type='int8')
    cues, transcripts, offset = [], [], 0.0
    for shot in request['shots']:
        if not shot['dialogue'].strip():
            offset += shot['duration']
            continue
        wave = destination.parent / (shot['id'] + '.wav')
        subprocess.run([os.environ.get('HYPIT_ECOMMERCE_FFMPEG', 'ffmpeg'), '-y', '-hide_banner', '-loglevel', 'error', '-ss', str(shot['start']), '-i', shot['file'], '-t', str(shot['duration']), '-vn', '-ar', '16000', '-ac', '1', str(wave)], check=True)
        segments, _ = model.transcribe(str(wave), language='zh', word_timestamps=True, vad_filter=False)
        recognized, timings, raw = '', [], []
        for segment in segments:
            raw.append(segment.text)
            for word in segment.words or []:
                chars = normalized(word.word)
                for i, char in enumerate(chars):
                    recognized += char
                    span = max(0.001, word.end - word.start) / len(chars)
                    timings.append((word.start + i * span, word.start + (i + 1) * span))
        if not timings:
            raise RuntimeError('No speech found in ' + shot['id'] + '; review the actual clip')
        authored = normalized(shot['dialogue'])
        matcher, metrics = compare_speech(authored, recognized)
        mapping = {}
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            for i in range(i1, i2):
                mapping[i] = min(len(timings)-1, j1 + int((i-i1) * max(1, j2-j1) / max(1, i2-i1)))
        cursor, previous = 0, 0.0
        for text in clauses(shot['dialogue']):
            length = len(normalized(text))
            if not length:
                continue
            start = max(previous, timings[mapping.get(cursor, 0)][0])
            end = min(shot['duration'], timings[mapping.get(cursor+length-1, len(timings)-1)][1])
            if end <= start:
                raise RuntimeError('Unreliable cue timings in ' + shot['id'] + '; review manually')
            cues.append({'shot_id': shot['id'], 'start': round(offset+start, 3), 'end': round(offset+end, 3), 'text': text})
            cursor += length
            previous = end
        transcripts.append({'id': shot['id'], 'recognized': ''.join(raw), 'authored': shot['dialogue'],
                            **metrics,
                            'speech_start': timings[0][0], 'speech_end': timings[-1][1], 'offset': offset, 'needs_review': True})
        offset += shot['duration']
    destination.write_text(json.dumps({'reviewed': False, 'cues': cues, 'transcripts': transcripts}, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
