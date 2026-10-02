/** Canned prospect replies, by intent. `{first}` is the sender's first name, `{company}` the lead's company. */

export type ReplyIntent = 'interested' | 'question' | 'not_now' | 'not_interested' | 'ooo' | 'wrong_person';

export const REPLY_BANK: Record<ReplyIntent, string[]> = {
  interested: [
    'Hi {first}, thanks for reaching out. This is timely, we were just talking about this. Do you have 20 minutes next week?',
    'Sounds interesting. Can you send over a couple of times that work for a quick call?',
    'Happy to chat. Tuesday or Wednesday afternoon works for me.',
    'Yes, keen to learn more. What does pricing look like for a team of our size?',
    'Thanks {first}! We are reviewing tools for Q1, so the timing is good. Let us set up a call.',
    'Appreciate the note. Could you share a short overview? If it fits, I will loop in our head of sales.',
    'Good timing actually. Grab a slot on my calendar and we can go through it.',
    'This could be useful for {company}. Free on Thursday at 3pm?',
  ],
  question: [
    'Thanks for connecting. How is this different from what we already do in our CRM?',
    'Interesting. Does it work with LinkedIn and email from the same place?',
    'Quick question before we talk: do you support teams in Europe?',
    'What kind of results do teams like ours usually see in the first month?',
    'Can you tell me a bit more about how the daily limits work?',
    'Who else in our space is using this?',
  ],
  not_now: [
    'Thanks {first}, not a priority this quarter. Feel free to check back in the new year.',
    'Appreciate it, but we are heads down on a launch right now. Maybe in a couple of months.',
    'We just signed a contract with another vendor, so not for now. Happy to stay connected.',
    'Not the right time, budget is frozen until Q2.',
    'Interesting, but let us revisit this after our planning cycle in January.',
  ],
  not_interested: [
    'Thanks, but we are all set.',
    'Not interested, thank you.',
    'We handle this in-house, so we will pass. Good luck!',
    'Please remove me from your list.',
  ],
  ooo: [
    'I am out of the office until Monday with limited access to messages. I will reply when I am back.',
    'Thanks for your message. I am on leave this week and will respond on my return.',
    'Auto-reply: I am travelling for a conference and will get back to you next week.',
  ],
  wrong_person: [
    'I am not the right person for this. You may want to reach out to our marketing lead instead.',
    'Thanks, but I moved to a different team. Try our operations director.',
    'Wrong person, sorry. I am in finance.',
  ],
};

/** Weighted mix that keeps the demo inbox upbeat but believable. */
export const INTENT_WEIGHTS: Array<[ReplyIntent, number]> = [
  ['interested', 34], ['question', 22], ['not_now', 18], ['not_interested', 10], ['ooo', 9], ['wrong_person', 7],
];

/** Replies to the visitor's own message in the inbox. */
export const FOLLOW_UP_REPLIES = [
  'Thanks, that helps. Let me check with the team and get back to you.',
  'Great, Thursday works. Send the invite over.',
  'Perfect, I will take a look this afternoon.',
  'Makes sense. Can you also share a case study?',
  'Got it, thanks for the quick answer!',
  'Sounds good. Talk soon.',
];

export const SUMMARIES: Record<ReplyIntent, string> = {
  interested: 'Interested and open to a call.',
  question: 'Asked a question before committing to a call.',
  not_now: 'Not a priority right now; check back later.',
  not_interested: 'Not interested.',
  ooo: 'Out of office auto-reply.',
  wrong_person: 'Not the right contact; pointed elsewhere.',
};
