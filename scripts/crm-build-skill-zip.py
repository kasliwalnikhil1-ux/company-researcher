"""Build claude-skill/crm.zip for upload to claude.ai (Settings -> Capabilities -> Skills).

Python's zipfile on purpose: PowerShell's Compress-Archive writes backslash paths, which claude.ai rejects.
Usage: python scripts/crm-build-skill-zip.py
"""
import os
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "claude-skill")
SKILL = "crm"
BACKSLASH = chr(92)

os.chdir(ROOT)
files = sorted(os.path.join(d, f) for d, _, fs in os.walk(SKILL) if "__pycache__" not in d for f in fs if not f.endswith(".pyc"))
with zipfile.ZipFile(f"{SKILL}.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for p in files:
        z.write(p, p.replace(os.sep, "/"))

names = zipfile.ZipFile(f"{SKILL}.zip").namelist()
assert f"{SKILL}/SKILL.md" in names, "SKILL.md must sit at <skill>/SKILL.md"
assert not any(BACKSLASH in n for n in names), "backslash path in zip"
print(f"{SKILL}.zip: {len(names)} files")
for n in names:
    print("  ", n)
