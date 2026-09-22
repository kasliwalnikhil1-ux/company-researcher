#!/usr/bin/env python3
"""Post a get-transcript output folder to the Sales CRM, against one meeting.

An hour-long call is ~10,000 words. Passing that through a connector tool argument means retyping it, which is slow
and can change the wording. This script reads the transcript pack from disk and posts it straight to the CRM with a
one-time ticket, so the saved transcript is byte-for-byte what Deepgram returned.

    1. transcript_upload_ticket(meeting_id)   -> upload_url + token   (connector tool; 30 minutes, single use)
    2. python save_transcript.py <pack_dir> --url <upload_url> --token <token> \
           --speaker "Speaker 1=Aarushi:team" --speaker "Speaker 2=Naman Jain:prospect"

<pack_dir> is the folder get-transcript wrote (metadata.json, response.json, words.json, intelligence.json ...).

Each turn also carries the transcriber's word timings ("w": one [start, end] per whitespace token of its text), so the
app highlights the exact word being said and plays from any word. They are stored, not shown to Claude.

--speaker "<label as printed in the transcript files>=<real name>[:prospect|team]"
    The pack prints speakers 1-based ("Speaker 1"); the CRM stores Deepgram's 0-based index. Give the label exactly as
    transcript.speakers.txt shows it and the script does the mapping. A bare number works too ("2=Naman:prospect").

The call AUDIO is stored too (the studio's private Oracle bucket), with the same ticket, before the transcript is
posted. Only ever audio: if the recording is a video, its audio track is extracted and the video itself is never uploaded. It uses --recording if given, else the audio get-transcript kept in the pack (run transcribe.py with
--keep-audio -> audio.flac). With ffmpeg on PATH it is first shrunk to mono 32 kbps AAC (.m4a, ~15 MB per hour, plays
in every browser). Audio problems never block the transcript: it prints RECORDING_SKIPPED / RECORDING_FAILED and
carries on. --no-audio skips it.

Exit code 0 = transcript saved. On a network failure it prints UPLOAD_FAILED and exits 2: fall back to the connector's
save_transcript tool. Python standard library only.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

MAX_TURN_CHARS = 900      # a long monologue is split into readable, searchable turns
ROLES = ("prospect", "team", "unknown")


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


def merge(segments):
    """Consecutive segments from one speaker become one turn, capped at MAX_TURN_CHARS. Word timings travel along."""
    turns = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        words = list(s.get("words") or [])
        last = turns[-1] if turns else None
        if last and last["speaker"] == s.get("speaker") and len(last["text"]) + len(text) + 1 <= MAX_TURN_CHARS:
            last["text"] += " " + text
            last["end"] = s.get("end") if s.get("end") is not None else last["end"]
            last["_words"] += words
        else:
            turns.append({"speaker": s.get("speaker"), "start": num(s.get("start")), "end": num(s.get("end")), "text": text, "_words": words})
    return turns


def norm(t):
    return re.sub(r"[\W_]+", "", t or "").lower()


def word_times(turn):
    """One [start, end] per whitespace token of the turn's text, from the transcriber's own word timings, so the app
    can highlight the word being said and play from any word. Usually the tokens ARE the words (1:1); otherwise tokens
    are matched to words in order, and any token left over gets a time interpolated between its neighbours.
    None when there is nothing to go on (a pack without word timings)."""
    words = [w for w in turn.pop("_words", []) if isinstance(w.get("start"), (int, float))]
    tokens = turn["text"].split()
    if not words or not tokens:
        return None
    if len(words) == len(tokens) and sum(norm(t) == norm(w.get("text")) for t, w in zip(tokens, words)) >= 0.9 * len(tokens):
        return [[num(w["start"]), num(w.get("end") if isinstance(w.get("end"), (int, float)) else w["start"])] for w in words]
    out, j = [None] * len(tokens), 0
    for i, tok in enumerate(tokens):
        key = norm(tok)
        for k in range(j, min(j + 6, len(words))):
            wkey = norm(words[k].get("text"))
            if key and wkey and (key == wkey or key.startswith(wkey) or wkey.startswith(key)):
                w = words[k]
                out[i] = [num(w["start"]), num(w.get("end") if isinstance(w.get("end"), (int, float)) else w["start"])]
                j = k + 1
                break
    start = turn["start"] if turn.get("start") is not None else 0
    end = turn["end"] if turn.get("end") is not None else start
    known = [i for i, x in enumerate(out) if x]
    if not known:
        return None
    for i, x in enumerate(out):
        if x:
            continue
        before = max((k for k in known if k < i), default=None)
        after = min((k for k in known if k > i), default=None)
        a = out[before][1] if before is not None else start
        b = out[after][0] if after is not None else max(end, a)
        lo, hi = (before if before is not None else -1), (after if after is not None else len(tokens))
        t = a + (b - a) * (i - lo) / (hi - lo)
        out[i] = [num(t), num(t)]
    return out


def segments_from_response(resp):
    utts = ((resp or {}).get("results") or {}).get("utterances") or []
    return [{"speaker": u.get("speaker"), "start": u.get("start"), "end": u.get("end"), "text": u.get("transcript"),
             "words": [{"text": w.get("punctuated_word") or w.get("word"), "start": w.get("start"), "end": w.get("end")} for w in u.get("words") or []]}
            for u in utts]


def segments_from_words(words):
    """No utterances (older pack / Whisper): rebuild segments from words, breaking on speaker change or a 1.2s pause."""
    segs, cur = [], None
    for w in words or []:
        text = w.get("word") or w.get("raw")
        if not text:
            continue
        gap = (w.get("start") or 0) - (cur["end"] or 0) if cur else 0
        timed = {"text": text, "start": w.get("start"), "end": w.get("end")}
        if cur and cur["speaker"] == w.get("speaker") and gap < 1.2:
            cur["text"] += " " + text
            cur["end"] = w.get("end")
            cur["words"].append(timed)
        else:
            cur = {"speaker": w.get("speaker"), "start": w.get("start"), "end": w.get("end"), "text": text, "words": [timed]}
            segs.append(cur)
    return segs


TIMED = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\s*-\s*(\d+):(\d+(?:\.\d+)?)\]\s*(?:(.+?):\s)?(.*)$")


def segments_from_timed(path, label_to_index):
    segs = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        m = TIMED.match(line.strip())
        if not m:
            continue
        m1, s1, m2, s2, label, text = m.groups()
        segs.append({"speaker": label_to_index.get((label or "").strip().lower()), "start": int(m1) * 60 + float(s1),
                     "end": int(m2) * 60 + float(s2), "text": text})
    return segs


AUDIO_TYPES = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/opus", ".aac": "audio/aac"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv"}     # only ever a SOURCE: the audio track is pulled out, the video is never stored
UA = "crm-skill-save-transcript/1"


def find_audio(pack, override):
    if override:
        p = Path(override)
        return p if p.is_file() else None
    for name in ("audio.flac", "audio.wav", "audio.m4a", "audio.mp3"):
        if (pack / name).is_file():
            return pack / name
    return None


def shrink(src, workdir):
    """Mono 32 kbps AAC, audio track only (-vn): speech stays clear, an hour is ~15 MB, every browser plays it.
    No ffmpeg -> the source is returned as is, and upload_audio() refuses it unless it is already an audio file."""
    if not shutil.which("ffmpeg"):
        return src
    out = Path(workdir) / "call.m4a"
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", str(out)],
                       capture_output=True, text=True)
    return out if r.returncode == 0 and out.is_file() and out.stat().st_size > 0 else src


def call(url, token, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def upload_audio(base, token, src, original_name, duration):
    """upload-url -> PUT straight to storage -> confirm. Returns a one-line status; never raises."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            f = shrink(src, tmp)
            if f.suffix.lower() in VIDEO_EXT or f.suffix.lower() not in AUDIO_TYPES:
                return (f"RECORDING_SKIPPED: {src.name} is not an audio file and its audio could not be extracted "
                        f"({'ffmpeg failed' if shutil.which('ffmpeg') else 'ffmpeg not found'}). Only audio is stored, never video - the transcript is still saved.")
            ctype = AUDIO_TYPES[f.suffix.lower()]
            size = f.stat().st_size
            grant = call(f"{base}/recording/upload-url", token, {"content_type": ctype, "filename": f.name, "bytes": size})
            with open(f, "rb") as fh:
                put = urllib.request.Request(grant["put_url"], data=fh, method="PUT", headers={"Content-Type": ctype, "Content-Length": str(size), "User-Agent": UA})
                urllib.request.urlopen(put, timeout=1800).read()
            call(f"{base}/recording/confirm", token, {"key": grant["key"], "content_type": ctype, "filename": original_name or src.name, "duration_seconds": duration})
            return f"RECORDING_SAVED: {size / 1048576:.1f} MB {f.suffix[1:]} ({'compressed from ' + src.name if f != src else 'as is - ffmpeg not found'})"
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))
        except ValueError:
            err = {}
        if err.get("code") == "E_STORAGE_NOT_CONFIGURED":
            return "RECORDING_SKIPPED: audio storage is not set up on the CRM yet (the transcript is still saved)."
        return f"RECORDING_FAILED ({e.code} {err.get('code', '')}): {err.get('message') or e.reason}"
    except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
        return f"RECORDING_FAILED: {e}"


def main():
    ap = argparse.ArgumentParser(description="Post a get-transcript pack to the Sales CRM.")
    ap.add_argument("pack", help="get-transcript output folder")
    ap.add_argument("--url", help="upload_url from transcript_upload_ticket")
    ap.add_argument("--token", help="token from transcript_upload_ticket")
    ap.add_argument("--speaker", action="append", default=[], metavar='"Speaker 1=Name:role"',
                    help="name a voice and say which side it is on (repeatable)")
    ap.add_argument("--source", help="recording file name or link (default: taken from the pack)")
    ap.add_argument("--recording", help="audio/video file to store (default: the audio.flac get-transcript kept with --keep-audio)")
    ap.add_argument("--no-audio", action="store_true", help="save the transcript only")
    ap.add_argument("--dry-run", action="store_true", help="build the payload and print its stats; post nothing")
    a = ap.parse_args()

    pack = Path(a.pack)
    if not pack.is_dir():
        sys.exit(f"ERROR: {pack} is not a folder. Pass the folder get-transcript wrote (the one holding metadata.json).")
    meta = load(pack / "metadata.json") or {}
    intel = load(pack / "intelligence.json") or {}
    if not meta:
        sys.exit(f"ERROR: no metadata.json in {pack}. With several inputs get-transcript writes one subfolder per file — pass that subfolder.")

    # label (as printed) -> 0-based index
    stats = {s.get("speaker"): s for s in meta.get("speakers") or [] if isinstance(s.get("speaker"), int)}
    label_to_index = {str(s.get("label") or f"Speaker {i + 1}").strip().lower(): i for i, s in stats.items()}

    segs = segments_from_response(load(pack / "response.json"))
    if not segs:
        segs = segments_from_words(load(pack / "words.json"))
    if not segs and (pack / "transcript.timed.txt").exists():
        segs = segments_from_timed(pack / "transcript.timed.txt", label_to_index)
    turns = merge(segs)
    if not turns:
        sys.exit(f"ERROR: could not find any speech in {pack} (looked at response.json, words.json, transcript.timed.txt).")

    # turns rebuilt from transcript.timed.txt carry no words: take them from words.json by time (and voice)
    if any(not t["_words"] for t in turns):
        all_words = [{"text": w.get("word") or w.get("raw"), "start": w.get("start"), "end": w.get("end"), "speaker": w.get("speaker")}
                     for w in load(pack / "words.json") or [] if isinstance(w.get("start"), (int, float))]
        for t in turns:
            if t["_words"] or t["start"] is None:
                continue
            hi = t["end"] if t["end"] is not None else t["start"]
            t["_words"] = [w for w in all_words if t["start"] - 0.05 <= w["start"] <= hi + 0.05
                           and (t["speaker"] is None or w["speaker"] is None or w["speaker"] == t["speaker"])]
    timed = 0
    for t in turns:
        w = word_times(t)
        if w:
            t["w"] = w
            timed += 1

    seen = sorted({t["speaker"] for t in turns if isinstance(t["speaker"], int)})
    named = {}
    for spec in a.speaker:
        if "=" not in spec:
            sys.exit(f'ERROR: --speaker "{spec}" must look like "Speaker 1=Naman Jain:prospect".')
        key, value = spec.split("=", 1)
        name, _, role = value.rpartition(":") if value.rsplit(":", 1)[-1].strip().lower() in ROLES else (value, "", "")
        key = key.strip().lower()
        idx = label_to_index.get(key)
        if idx is None and key.isdigit():
            idx = int(key) - 1                      # bare "2" means the pack's "Speaker 2" -> index 1
        if idx is None or (seen and idx not in seen):
            known = ", ".join(f'"{s.get("label") or "Speaker " + str(i + 1)}"' for i, s in sorted(stats.items())) or "none (not diarized)"
            sys.exit(f'ERROR: --speaker "{spec}": no voice called "{key}" in this pack. Voices: {known}.')
        named[idx] = {"label": name.strip(), "role": (role.strip().lower() or "unknown")}

    speakers = []
    for i in seen:
        st = stats.get(i, {})
        speakers.append({k: v for k, v in {
            "speaker": i,
            "label": named.get(i, {}).get("label") or st.get("label") or f"Speaker {i + 1}",
            "role": named.get(i, {}).get("role", "unknown"),
            "words": st.get("words"), "share_of_words": st.get("share_of_words"), "speaking_seconds": st.get("speaking_seconds"),
        }.items() if v is not None})

    payload = {k: v for k, v in {
        "turns": turns, "speakers": speakers,
        "summary": intel.get("summary"), "topics": (intel.get("top_topics") or [])[:12],
        "language": meta.get("language"), "duration_seconds": meta.get("duration_seconds"), "word_count": meta.get("word_count"),
        "avg_confidence": meta.get("avg_word_confidence"), "low_confidence": (meta.get("low_confidence_words") or [])[:50],
        "source": a.source or meta.get("source"), "engine": meta.get("engine"), "model": meta.get("model"),
    }.items() if v not in (None, "", [])}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    roles = ", ".join(f'{s["label"]} ({s["role"]}, {round(100 * s.get("share_of_words", 0))}% of words)' for s in speakers) or "not diarized"
    print(f"transcript: {len(turns)} turns, {payload.get('word_count', '?')} words, {round((payload.get('duration_seconds') or 0) / 60)} min, {len(body) // 1024} KB")
    print(f"word times: {timed} of {len(turns)} turns" + ("" if timed == len(turns) else " - the app estimates the rest from the turn's start/end"))
    print(f"speakers:   {roles}")
    if speakers and not any(s["role"] == "prospect" for s in speakers):
        print('WARNING: no voice is marked prospect. Pass --speaker "<label>=<name>:prospect" so the CRM knows whose words are the customer\'s.')
    if meta.get("engine") == "whisper":
        print("NOTE: Whisper fallback pack — no speaker labels, no confidence data.")
    audio = None if a.no_audio else find_audio(pack, a.recording)
    if a.no_audio:
        pass
    elif audio:
        print(f"audio:      {audio.name} ({audio.stat().st_size / 1048576:.1f} MB){'' if shutil.which('ffmpeg') else (' - ffmpeg not found, cannot pull the audio out of a video' if audio.suffix.lower() in VIDEO_EXT else ' - ffmpeg not found, will upload as is')}")
    else:
        print("audio:      none found - rerun get-transcript with --keep-audio, or pass --recording <file>, to store the call audio")
    if a.dry_run:
        print("dry run: nothing posted.")
        return
    if not a.url or not a.token:
        sys.exit("ERROR: --url and --token are required (from the connector's transcript_upload_ticket tool).")

    # audio first: it needs the ticket unconsumed, and saving the transcript is what consumes it
    if audio:
        print(upload_audio(a.url.rsplit("/transcript", 1)[0], a.token, audio, Path(a.recording).name if a.recording else a.source, payload.get("duration_seconds")))

    req = urllib.request.Request(a.url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {a.token}", "Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:                      # the CRM answered and said no — a retry with the same input will not help
        try:
            err = json.loads(e.read().decode("utf-8"))
        except ValueError:
            err = {}
        print(f"REJECTED ({e.code} {err.get('code', '')}): {err.get('message') or e.reason}")
        if e.code == 401:
            print("The ticket is expired or used. Call transcript_upload_ticket again and rerun with the new token.")
        sys.exit(1)
    except (urllib.error.URLError, OSError) as e:            # never reached the CRM
        print(f"UPLOAD_FAILED: could not reach {a.url} ({e}). The ticket is still valid. "
              "If this environment blocks the network, save with the connector's save_transcript tool instead.")
        sys.exit(2)
    print(f"SAVED: {out.get('company') or 'meeting'} {str(out.get('scheduled_at') or '')[:10]} — {out.get('turn_count')} turns on meeting {out.get('meeting_id')}")


if __name__ == "__main__":
    main()
