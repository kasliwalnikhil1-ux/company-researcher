// Calendar-invite title / description templates (team settings invite_title_template / invite_description_template).
// Mirror of supabase/functions/crm-mcp/invite_template.ts — keep the two in sync.
//
// Placeholders: {me} my first name · {me_full} my display name · {who} contact first name, else company ·
// {contact} contact full name · {contact_first} · {company} · {studio} studio name · {notes} meeting notes.
// Rendering drops separators left dangling by empty values (" · ", " - ", " x ", " <> ") and blank lines, so
// "{company} · {contact}" with no contact gives "Acme", and "{notes}\n\n{company}" with no notes gives "Acme".

export const INVITE_DEFAULTS = { title: "{me} <> {who}", description: "{notes}\n\n{company} · {contact}" } as const;
export const INVITE_PLACEHOLDERS = ["me", "me_full", "who", "contact", "contact_first", "company", "studio", "notes"] as const;

export interface InviteVars { me?: string | null; contact?: string | null; company?: string | null; studio?: string | null; notes?: string | null }

const firstName = (s: string | null | undefined) => String(s ?? "").trim().split(/\s+/)[0] || "";
// A separator is whitespace + symbol + ONE whitespace char (not greedy), so two separators around an empty value both match.
const SEP = /(\s+(?:·|-|–|—|x|X|×|<>|\||\/)\s|\s*:\s)/;

export function renderInvite(template: string | null | undefined, v: InviteVars, fallback: string): string {
  const tpl = String(template ?? "").trim() || fallback;
  const contact = String(v.contact ?? "").trim(), company = String(v.company ?? "").trim();
  const vals: Record<string, string> = {
    me: firstName(v.me), me_full: String(v.me ?? "").trim(), who: firstName(contact) || company,
    contact, contact_first: firstName(contact), company, studio: String(v.studio ?? "").trim(), notes: String(v.notes ?? "").trim(),
  };
  const out = tpl.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vals ? vals[k] : m));
  return out.split(/\r?\n/)
    .map((line) => {
      const tok = line.split(SEP); // [text, sep, text, sep, …]
      let joined = "";
      for (let i = 0; i < tok.length; i += 2) { const t = tok[i].trim(); if (!t) continue; joined = joined ? `${joined}${(tok[i - 1] ?? " · ").replace(/\s+$/, " ")}${t}` : t; }
      return joined;
    })
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function inviteTitle(settings: Record<string, unknown> | null | undefined, v: InviteVars): string {
  return renderInvite(settings?.invite_title_template as string | undefined, v, INVITE_DEFAULTS.title).slice(0, 300) || `${firstName(v.me)} <> ${firstName(v.contact) || v.company || ""}`.trim();
}
export function inviteDescription(settings: Record<string, unknown> | null | undefined, v: InviteVars): string {
  return renderInvite(settings?.invite_description_template as string | undefined, v, INVITE_DEFAULTS.description).slice(0, 5000);
}
