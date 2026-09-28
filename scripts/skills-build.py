"""Build every distributable form of the connector skills from claude-skill/<skill>/ (the one source of truth).

    python scripts/skills-build.py              # everything below
    python scripts/skills-build.py --gen-only   # only (1) — the crm/smartlead deploy scripts run this first

Writes three things:

1. supabase/functions/<fn>/skills.gen.ts — the skill served by the MCP server itself (read_skill tool, skill://
   resources, skills/list + skills/get; see supabase/functions/_shared/mcp-skills.ts). Redeploy the function after.
2. chatgpt-plugin/<plugin>/ + chatgpt-plugin/dist/<plugin>.zip — ChatGPT / Codex plugin packages (portable Agent
   Plugins layout: plugin.json + mcp.json + skills/<skill>/), one per connector. Upload the zip in ChatGPT
   (Plugins -> Upload plugin) or point a local marketplace at the folder.
3. claude-skill/<skill>.zip — the claude.ai skill upload (Settings -> Capabilities -> Skills).

Zips are written with Python's zipfile on purpose: PowerShell's Compress-Archive writes backslash paths, which both
claude.ai and the OpenAI plugin importer reject.
"""
import hashlib
import json
import os
import shutil
import zipfile
from datetime import date

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SKILLS_DIR = os.path.join(ROOT, "claude-skill")
FUNCTIONS_DIR = os.path.join(ROOT, "supabase", "functions")
PLUGIN_DIR = os.path.join(ROOT, "chatgpt-plugin")
FUNCTIONS_BASE = "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1"
WEB = "https://app.capitalxai.com"
VERSION = f"{date.today().year}.{date.today().month}.{date.today().day}"
BACKSLASH = chr(92)

# function -> the skills it serves (capitalxai-mcp picks one per caller: admin accounts get capitalxai-admin)
FUNCTIONS = {
    "capitalxai-mcp": ["capitalxai", "capitalxai-admin"],
    "crm-mcp": ["crm"],
    "smartlead-mcp": ["smartlead"],
}

PLUGINS = [
    {
        "name": "capitalxai", "skill": "capitalxai", "fn": "capitalxai-mcp", "server": "capitalxai",
        "display": "CapitalxAI", "short": "Investor database and investor-fit analysis",
        "long": "Search the CapitalxAI investor database (firms and people) and recent funding rounds, and run the app's investor-fit analysis for your company.",
        "homepage": WEB, "capabilities": ["Read", "Write"], "keywords": ["fundraising", "investors", "venture capital"],
        "prompts": ["Find seed-stage fintech investors in India", "Analyze accel.com for my company", "Show this week's new fundings"],
    },
    {
        "name": "capitalxai-admin", "skill": "capitalxai-admin", "fn": "capitalxai-mcp", "server": "capitalxai",
        "display": "CapitalxAI Admin", "short": "Maintain the CapitalxAI investor database (admins only)",
        "long": "Research investors and add or update them, record funding rounds, merge duplicates and find verified emails. For CapitalxAI admin accounts only; do not share with other users.",
        "homepage": WEB, "capabilities": ["Read", "Write"], "keywords": ["fundraising", "investors", "admin"],
        "prompts": ["Research sequoiacap.com and add it", "Run the new-fundings sweep", "Fill missing emails for 10 people"],
    },
    {
        "name": "capitalxai-crm", "skill": "crm", "fn": "crm-mcp", "server": "capitalxai-crm",
        "display": "CapitalxAI Sales CRM", "short": "Standup brief, one-minute meeting capture, call coaching",
        "long": "The studio's sales CRM: read the daily standup, capture a meeting from a few words or its recording, coach every call, and answer pipeline questions.",
        "homepage": f"{WEB}/crm", "capabilities": ["Read", "Write"], "keywords": ["crm", "sales", "standup", "call coaching"],
        "prompts": ["Who are we meeting today?", "We just finished the GrowthX call: they need realism, quoted 40K for 8 videos", "Coach my last call"],
    },
    {
        "name": "capitalxai-smartlead", "skill": "smartlead", "fn": "smartlead-mcp", "server": "capitalxai-smartlead",
        "display": "CapitalxAI Smartlead", "short": "Cold-email campaigns, replies and mailbox health",
        "long": "Run Smartlead cold email through guarded tools: morning digest, burn check, reply triage and copy iteration, with confirmation before anything sends or changes.",
        "homepage": WEB, "capabilities": ["Read", "Write"], "keywords": ["cold email", "smartlead", "outreach"],
        "prompts": ["Morning digest", "Are any mailboxes burning?", "Triage today's replies"],
    },
]


def skill_files(skill):
    """(relative path, text) for every file of a skill, SKILL.md first. Line endings normalised to LF."""
    base = os.path.join(SKILLS_DIR, skill)
    if not os.path.isfile(os.path.join(base, "SKILL.md")):
        raise SystemExit(f"ERROR: {base}/SKILL.md not found")
    out = []
    for d, dirs, fs in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x != "__pycache__")
        for f in sorted(fs):
            if f.endswith((".pyc", ".zip")):
                continue
            rel = os.path.relpath(os.path.join(d, f), base).replace(os.sep, "/")
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                out.append((rel, fh.read().replace("\r\n", "\n")))
    out.sort(key=lambda x: (x[0] != "SKILL.md", x[0]))
    return out


def frontmatter(text):
    if not text.startswith("---\n"):
        raise SystemExit("ERROR: SKILL.md must start with --- front matter")
    block = text[4:text.index("\n---", 4)]
    fm = {}
    for line in block.splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    if not fm.get("name") or not fm.get("description"):
        raise SystemExit("ERROR: front matter needs name and description")
    return fm


def bundle(skill):
    files = skill_files(skill)
    fm = frontmatter(files[0][1])
    if fm["name"] != skill:
        raise SystemExit(f"ERROR: claude-skill/{skill}/SKILL.md has name '{fm['name']}' — the folder and the name must match")
    return {"name": skill, "frontmatter": fm,
            "files": [{"path": p, "text": t, "digest": "sha256:" + hashlib.sha256(t.encode("utf-8")).hexdigest()} for p, t in files]}


def write_gen(fn, skills):
    path = os.path.join(FUNCTIONS_DIR, fn, "skills.gen.ts")
    body = {s: bundle(s) for s in skills}
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("// GENERATED by scripts/skills-build.py from claude-skill/ — do not edit. Edit the skill, rerun the script, redeploy.\n")
        fh.write('import type { SkillBundle } from "../_shared/mcp-skills.ts";\n\n')
        fh.write(f"export const SKILLS: Record<string, SkillBundle> = {json.dumps(body, ensure_ascii=False, indent=1)};\n")
    size = os.path.getsize(path)
    print(f"  {os.path.relpath(path, ROOT)}  ({', '.join(skills)}; {size // 1024} KB)")


def zip_dir(src_dir, zip_path, top):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for d, dirs, fs in os.walk(src_dir):
            dirs[:] = sorted(x for x in dirs if x != "__pycache__")
            for f in sorted(fs):
                if f.endswith(".pyc"):
                    continue
                full = os.path.join(d, f)
                z.write(full, top + "/" + os.path.relpath(full, src_dir).replace(os.sep, "/"))
    names = zipfile.ZipFile(zip_path).namelist()
    assert not any(BACKSLASH in n for n in names), f"backslash path in {zip_path}"
    return names


def write_plugin(p):
    out = os.path.join(PLUGIN_DIR, p["name"])
    shutil.rmtree(out, ignore_errors=True)
    skill_out = os.path.join(out, "skills", p["skill"])
    os.makedirs(os.path.join(skill_out, "agents"), exist_ok=True)
    os.makedirs(os.path.join(out, "assets"), exist_ok=True)
    url = f"{FUNCTIONS_BASE}/{p['fn']}/mcp-chatgpt"   # ChatGPT's own URL: its OAuth metadata leaves out openid (functions/oauth-as)

    for rel, text in skill_files(p["skill"]):
        dst = os.path.join(skill_out, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    with open(os.path.join(skill_out, "agents", "openai.yaml"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("dependencies:\n  tools:\n")
        fh.write(f'    - type: "mcp"\n      value: "{p["server"]}"\n      description: {json.dumps(p["short"])}\n')
        fh.write(f'      transport: "streamable_http"\n      url: "{url}"\n')

    logo = os.path.join(ROOT, "public", "logo.png")
    if os.path.isfile(logo):
        shutil.copyfile(logo, os.path.join(out, "assets", "logo.png"))

    manifest = {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        "name": p["name"], "version": VERSION, "description": p["long"],
        "author": {"name": "CapitalxAI", "url": WEB},
        "homepage": p["homepage"], "keywords": p["keywords"],
        "extensions": {"com.openai": {"interface": {
            "displayName": p["display"], "shortDescription": p["short"], "longDescription": p["long"],
            "developerName": "CapitalxAI", "category": "Productivity", "capabilities": p["capabilities"],
            "websiteURL": p["homepage"], "privacyPolicyURL": "https://capitalxai.com/privacy", "termsOfServiceURL": "https://capitalxai.com/terms",
            "defaultPrompt": p["prompts"], "composerIcon": "./assets/logo.png", "logo": "./assets/logo.png",
        }}},
    }
    mcp = {"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": {p["server"]: {"type": "streamable-http", "url": url}}}
    for name, obj in (("plugin.json", manifest), ("mcp.json", mcp)):
        with open(os.path.join(out, name), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    os.makedirs(os.path.join(PLUGIN_DIR, "dist"), exist_ok=True)
    names = zip_dir(out, os.path.join(PLUGIN_DIR, "dist", f"{p['name']}.zip"), p["name"])
    assert f"{p['name']}/plugin.json" in names and f"{p['name']}/skills/{p['skill']}/SKILL.md" in names
    print(f"  chatgpt-plugin/dist/{p['name']}.zip  ({len(names)} files, MCP {p['fn']})")


def write_claude_zip(skill):
    names = zip_dir(os.path.join(SKILLS_DIR, skill), os.path.join(SKILLS_DIR, f"{skill}.zip"), skill)
    assert f"{skill}/SKILL.md" in names
    print(f"  claude-skill/{skill}.zip  ({len(names)} files)")


if __name__ == "__main__":
    import sys
    print("MCP skill bundles:")
    for fn, skills in FUNCTIONS.items():
        write_gen(fn, skills)
    if "--gen-only" in sys.argv:        # the deploy scripts: refresh what the functions serve, leave the zips alone
        sys.exit(0)
    print("ChatGPT plugins:")
    for p in PLUGINS:
        write_plugin(p)
    print("claude.ai skill zips:")
    for skill in sorted({s for skills in FUNCTIONS.values() for s in skills}):
        write_claude_zip(skill)
