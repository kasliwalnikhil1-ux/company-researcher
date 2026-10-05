// Fictional content the tool adds because the source file has none: sample prospects, incoming
// prospect messages, default categories and the ordinary emails that surround our outreach in the
// simulated inboxes. Everything here is labelled as sample content in the UI.

import type { Category, Profile } from './types';
import { normKey } from './util';

export const SHORT_PROFILE: Omit<Profile, 'id'> = {
  label: 'Short sample (fictional)',
  recipientName: 'Mia Chen',
  recipientEmail: 'mia@lumo.example',
  values: {
    first_name: 'Mia',
    company: 'Lumo',
    collection_name: 'FW26',
    news_trigger: 'launched FW26',
    product: 'rings',
    'product/category': 'rings',
    personalized_trigger: 'the FW26 launch',
  },
};

export const LONG_PROFILE: Omit<Profile, 'id'> = {
  label: 'Long sample (fictional)',
  recipientName: 'Maximiliana-Alexandra Vandenberg-Rao',
  recipientEmail: 'maximiliana.vandenberg-rao@heritage-handloom-and-fine-jewellery.example',
  values: {
    first_name: 'Maximiliana-Alexandra',
    company: 'The Heritage Handloom & Fine Jewellery Company of Rajasthan',
    collection_name: 'Autumn/Winter 2026 Heritage Bridal & Festive Couture Collection',
    news_trigger:
      "opened your flagship store in Jaipur's Johari Bazaar and launched the Autumn/Winter 2026 bridal collection",
    product: 'hand-embroidered silk bridal lehengas',
    'product/category': 'hand-embroidered silk bridal lehengas and kundan jewellery sets',
    personalized_trigger: 'your Autumn/Winter 2026 bridal collection launch at the Jaipur flagship',
  },
};

/** The five buckets from the source's Reply Handling Framework (used when a file has none),
 *  plus one bucket the tool adds for timing / not-interested replies. */
export const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Curious', description: 'Send relevant proof and ask for a product.', addedByTool: false },
  { name: 'Quality Objection', description: 'Offer a sample using their own product.', addedByTool: false },
  { name: 'Price Objection', description: 'Explain scope/value briefly and ask for volume.', addedByTool: false },
  { name: 'Operational Question', description: 'Answer briefly, then move toward product/scope.', addedByTool: false },
  { name: 'Buying Signal', description: 'Stop pitching. Move directly to requirements, timeline and payment.', addedByTool: false },
];

export const TIMING_CATEGORY: Omit<Category, 'id'> = {
  name: 'Timing / Not Now',
  description: 'Added by the tool: replies about timing, team review or no interest. Not one of the five source buckets.',
  addedByTool: true,
};

/** Ordered rules: first match wins. Names refer to category names above. */
const CATEGORY_RULES: [RegExp, string][] = [
  [/not right now|reconnect|launching in|not interested|discuss with my team/, 'Timing / Not Now'],
  [/next steps|how soon can you start|charge upfront|how do we pay|demo|call or whatsapp|whole collection|100 500|every week|email me|send this to my/, 'Buying Signal'],
  [/how much|\$5|cheap/, 'Price Objection'],
  [/tried ai|guarantee|accurate|exact|preserve|complicated|generic|premium|chatgpt|different from an ai|don t like|revisions|is this ai/, 'Quality Objection'],
  [/interested|samples|examples|videos too|reels|meta ad|catalog shoots|white background|for a launch|worked with|who are you|deck|portfolio|make a sample/, 'Curious'],
];

export function suggestCategoryName(title: string): string {
  const key = normKey(title);
  for (const [re, name] of CATEGORY_RULES) if (re.test(key)) return name;
  return 'Operational Question';
}

/** Fictional incoming messages, keyed by the normalised reply title. */
const PROSPECT_SAMPLES: Record<string, string> = {
  'interested tell me more': 'This sounds interesting, tell me more.',
  'jewelry samples': 'Do you have any jewelry samples I could look at?',
  'apparel samples': "Can you share some apparel work you've done?",
  'send examples': 'Can you send some examples?',
  'how much': 'How much does this cost?',
  'is $5 really the price': 'Is $5 per product really the price?',
  'what s included in $5': "What's included in the $5?",
  'why is it so cheap': 'Why is it so cheap compared to a regular shoot?',
  'what do you need from us': 'What would you need from us to get started?',
  'how does it work': 'How does it work exactly?',
  'what kind of product images do you need': 'What kind of product images do you need from us?',
  'do we need to send physical products': 'Do we need to ship you the physical products?',
  'can you do our whole collection': 'Could you do our whole collection?',
  'can you handle 100 500 products': 'We have around 500 products. Can you handle that volume?',
  'can you deliver every week month': 'Could you deliver new content every month?',
  'can you make a sample': 'Can you make a sample first?',
  'do you do videos too': 'Do you do videos too?',
  'can you make reels': 'Can you make reels for Instagram?',
  'can you make meta ad creatives': 'Can you make Meta ad creatives?',
  'do you only do catalog shoots': 'Do you only do catalog shoots?',
  'can you do white background pdp images': 'Can you do white-background images for our product pages?',
  'can you create everything for a launch': 'We have a launch coming up. Could you create everything for it?',
  'is this ai': 'Is this all AI?',
  'why not just use chatgpt gemini': "Why wouldn't we just use ChatGPT or Gemini ourselves?",
  'how are you different from an ai tool': 'How is this different from using an AI tool?',
  'can we run it ourselves': 'Can we run it ourselves?',
  'we tried ai before and it looked bad': 'We tried AI before and honestly it looked bad.',
  'can you guarantee it won t look ai': "Can you guarantee it won't look like AI?",
  'how accurate are the products': 'How accurate are the products in the final images?',
  'will the jewelry product stay exact': 'Will the jewelry stay exactly the same?',
  'can you preserve logos text details': 'Can you keep our logos and the small details intact?',
  'our products are complicated': "Our products are quite intricate, not sure this would work.",
  'what resolution do we get': 'What resolution are the final files?',
  'can you match our brand aesthetic': "Can you match our brand's aesthetic?",
  'can i send pinterest references': 'Can I send you some Pinterest references?',
  'can you do styling': 'Do you handle styling as well?',
  'do we need models': 'Do we need to arrange models?',
  'can we use our existing model': 'Can we use the model we already work with?',
  'can you keep the same model across the collection': 'Can you keep the same model across the whole collection?',
  'we don t want generic ai looking models': "We don't want generic AI-looking models.",
  'our brand is very premium': 'Our brand is very premium, so quality is everything for us.',
  'can you work from our existing shoot': "Can you work from a shoot we've already done?",
  'we already have a shoot planned': 'We already have a shoot planned for this season.',
  'we already have a photographer agency': 'We already work with a photographer.',
  'we have an in house team': 'We have an in-house creative team.',
  'we only need a few products': 'We only need a few products done.',
  'what if i don t like the output': "What happens if I don't like the output?",
  'do you offer revisions': 'Do you offer revisions?',
  'how quickly': 'How quickly can you deliver?',
  'how soon can you start': 'How soon can you start?',
  'who have you worked with': 'Who have you worked with?',
  'who are you guys': 'Sorry, who are you guys?',
  'where are you based': 'Where are you based?',
  'can we do a demo talk': 'Can we get on a quick call?',
  'can i call or whatsapp': 'Can I call or WhatsApp you?',
  'send your deck': 'Can you send your deck?',
  'send your portfolio': 'Send me your portfolio.',
  'email me': 'Can you email me the details?',
  'send this to my marketing creative person': 'Let me send this to our marketing person.',
  'i ll discuss with my team': "I'll discuss this with my team.",
  'not right now': 'Not right now, thanks.',
  'let s reconnect next month': "Let's reconnect next month.",
  'we re launching in november': "We're launching our next collection in November.",
  'not interested': 'Not interested, thanks.',
  'do you charge upfront': 'Do you charge upfront?',
  'how do we pay': 'How do we pay you?',
  'can we use these commercially': 'Can we use the images commercially?',
  'will you post our work publicly': 'Will you post our work publicly?',
  'can you sign an nda': 'Can you sign an NDA?',
  'we can t share unreleased products': "We can't share unreleased products.",
  'what are the next steps': 'Okay, what are the next steps?',
};

export function sampleProspectMessage(title: string): string {
  const known = PROSPECT_SAMPLES[normKey(title)];
  if (known) return known;
  const t = normKey(title);
  const sentence = t.charAt(0).toUpperCase() + t.slice(1);
  return /\?\s*$/.test(title) ? `${sentence}?` : `${sentence}.`;
}

export interface FillerMail {
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  /** Minutes before the simulated "now". */
  minutesAgo: number;
  unread: boolean;
  attachment?: string;
  starred?: boolean;
}

/** Ordinary mail in the prospect's (recipient's) inbox. All senders are fictional. */
export const RECIPIENT_FILLER: FillerMail[] = [
  { fromName: 'Priya Nair', fromEmail: 'priya@studio-loom.example', subject: 'Re: Lookbook proofs', snippet: 'Looks great! Two small changes on page 6 — can we swap the second image for the close-up?', minutesAgo: 22, unread: true },
  { fromName: 'Northwind Payments', fromEmail: 'no-reply@northwind-pay.example', subject: 'Settlement processed for Oct 4', snippet: 'Your settlement of ₹2,48,310.00 has been processed and will reach your bank account within 1 business day.', minutesAgo: 95, unread: false },
  { fromName: 'Kabir (Ops)', fromEmail: 'kabir@ops.example', subject: 'Inventory sheet updated', snippet: 'Updated stock counts for the festive drop are in the shared sheet. 3 SKUs are below the reorder level.', minutesAgo: 180, unread: false, attachment: 'Inventory_Oct.xlsx' },
  { fromName: 'Courier Desk', fromEmail: 'updates@courierdesk.example', subject: 'Your pickup is scheduled for tomorrow', snippet: 'Pickup window: 11:00 AM – 2:00 PM. Please keep the packages sealed and labelled.', minutesAgo: 320, unread: false },
  { fromName: 'Retail Weekly', fromEmail: 'digest@retailweekly.example', subject: '5 things D2C founders are watching this festive season', snippet: 'Inside: why returns are rising, the new marketplace fee changes and what top brands spend on content.', minutesAgo: 1440 + 120, unread: false },
  { fromName: 'Sana Mehta', fromEmail: 'sana@creatorhub.example', subject: 'Influencer shortlist for Diwali', snippet: 'Sharing the 12 creators we discussed, with rates and past brand work. Let me know which ones to approach.', minutesAgo: 1440 + 300, unread: false, starred: true },
  { fromName: 'Team Calendar', fromEmail: 'calendar@team.example', subject: 'Invitation: Merch review @ Thu 3pm', snippet: 'You have been invited to Merch review. Thursday 3:00 – 3:45 PM. Join with the link in the invite.', minutesAgo: 2 * 1440 + 60, unread: false },
  { fromName: 'Stockroom', fromEmail: 'alerts@stockroom.example', subject: 'Low stock alert: 3 SKUs', snippet: 'These items are running low: Silk dupatta (rose), Kundan earrings set B, Linen kurta (M).', minutesAgo: 3 * 1440 + 200, unread: false },
];

/** Ordinary mail in our (sender's) inbox. All senders are fictional. */
export const SENDER_FILLER: FillerMail[] = [
  { fromName: 'Riya', fromEmail: 'riya@ourteam.example', subject: 'Re: FW26 renders', snippet: 'Second batch is uploaded. The model consistency on looks 4–7 is much better now.', minutesAgo: 35, unread: true },
  { fromName: 'Scheduler', fromEmail: 'notifications@scheduler.example', subject: 'New event: Intro call with Dev Patel', snippet: 'Invitee: Dev Patel. Event date: Thursday. Location: video call.', minutesAgo: 140, unread: false },
  { fromName: 'Billing', fromEmail: 'billing@payments.example', subject: 'Invoice #1042 paid', snippet: 'Payment of $480.00 received for invoice #1042. Thank you.', minutesAgo: 400, unread: false },
  { fromName: 'Arjun Shah', fromEmail: 'arjun@brandco.example', subject: 'Re: Sample for the earrings', snippet: 'These look really good. Can we do the same style for 20 more pieces next week?', minutesAgo: 1440 + 60, unread: false, starred: true },
  { fromName: 'Design Digest', fromEmail: 'hello@designdigest.example', subject: 'This week: campaign visuals that convert', snippet: 'Five teardown examples of high-performing product campaigns, plus a free moodboard template.', minutesAgo: 2 * 1440, unread: false },
  { fromName: 'Cloud Storage', fromEmail: 'no-reply@storage.example', subject: 'You are using 82% of your storage', snippet: 'Free up space or upgrade your plan to keep receiving files without interruption.', minutesAgo: 3 * 1440, unread: false },
];

export const DEFAULT_SENDER = { name: 'Aarushi Jain', email: 'aarushi@kaptured.ai' };
export const DEFAULT_SIGNATURE = 'Aarushi Jain\nCOO, Kaptured.AI';
