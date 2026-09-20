#!/usr/bin/env python3
"""Post a get-transcript output folder to the Sales CRM, against one meeting.

An hour-long call is ~10,000 words. Passing that through a connector tool argument means retyping it, which is slow
and can change the wording. This script reads the transcript pack from disk and posts it straight to the CRM with a
one-time ticket, so the saved transcript is byte-for-byte what Deepgram returned.

    1. transcript_upload_ticket(meeting_id)   -> upload_url + token   (connector tool; 30 minutes, single use)
    2. python save_transcript.py <pack_dir> --url <upload_url> --token <token> \
           --speaker "Speaker 1=Aarushi:team" --speaker "Speaker 2=Naman Jain:prospect"

<pack_dir> is the folder get-transcript wrote (metadata.json, response.json, words.json, intelligence.json ...).

--speaker "<label as printed in the transcript files>=<real name>[:prospect|team]"
    The pack prints speakers 1-based ("Speaker 1"); the CRM stores Deepgram's 0-based index. Give the label exactly as
    transcript.speakers.txt shows it and the script does the mapping. A bare number works too ("2=Naman:prospect").

Exit code 0 = saved. On a network failure it prints UPLOAD_FAILED and exits 2: fall back to the connector's
save_transcript tool. Python standard library only.
"""
import argparse
import json
import re
import sys
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
    """Consecutive segments from one speaker become one turn, capped at MAX_TURN_CHARS."""
    turns = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        last = turns[-1] if turns else None
        if last and last["speaker"] == s.get("speaker") and len(last["text"]) + len(text) + 1 <= MAX_TURN_CHARS:
            last["text"] += " " + text
            last["end"] = s.get("end") if s.get("end") is not None else last["end"]
        else:
            turns.append({"speaker": s.get("speaker"), "start": num(s.get("start")), "end": num(s.get("end")), "text": text})
    return turns


def segments_from_response(resp):
    utts = ((resp or {}).get("results") or {}).get("utterances") or []
    return [{"speaker": u.get("speaker"), "start": u.get("start"), "end": u.get("end"), "text": u.get("transcript")} for u in utts]


def segments_from_words(words):
    """No utterances (older pack / Whisper): rebuild segments from words, breaking on speaker change or a 1.2s pause."""
    segs, cur = [], None
    for w in words or []:
        text = w.get("word") or w.get("raw")
        if not text:
            continue
        gap = (w.get("start") or 0) - (cur["end"] or 0) if cur else 0
        if cur and cur["speaker"] == w.get("speaker") and gap < 1.2:
            cur["text"] += " " + text
            cur["end"] = w.get("end")
        else:
            cur = {"speaker": w.get("speaker"), "start": w.get("start"), "end": w.get("end"), "text": text}
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


def main():
    ap = argparse.ArgumentParser(description="Post a get-transcript pack to the Sales CRM.")
    ap.add_argument("pack", help="get-transcript output folder")
    ap.add_argument("--url", help="upload_url from transcript_upload_ticket")
    ap.add_argument("--token", help="token from transcript_upload_ticket")
    ap.add_argument("--speaker", action="append", default=[], metavar='"Speaker 1=Name:role"',
                    help="name a voice and say which side it is on (repeatable)")
    ap.add_argument("--source", help="recording file name or link (default: taken from the pack)")
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
    print(f"speakers:   {roles}")
    if speakers and not any(s["role"] == "prospect" for s in speakers):
        print('WARNING: no voice is marked prospect. Pass --speaker "<label>=<name>:prospect" so the CRM knows whose words are the customer\'s.')
    if meta.get("engine") == "whisper":
        print("NOTE: Whisper fallback pack — no speaker labels, no confidence data.")
    if a.dry_run:
        print("dry run: nothing posted.")
        return
    if not a.url or not a.token:
        sys.exit("ERROR: --url and --token are required (from the connector's transcript_upload_ticket tool).")

    req = urllib.request.Request(a.url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {a.token}", "Content-Type": "application/json", "User-Agent": "crm-skill-save-transcript/1"})
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
