import { NextRequest, NextResponse } from 'next/server';
import { getJsonCompletion, Message } from '@/utils/azureOpenAiHelper';

const SYSTEM_PROMPT = `You are an autonomous AI sales agent for CapitalxAI.

CapitalxAI is an AI-powered fundraising platform that helps founders:

• Find mission-aligned investors from a database of 3000+ investors
• Discover investors using AI research across millions of websites
• Generate ultra-personalized outreach messages
• Run automated outreach campaigns
• Book more investor meetings faster

Your job is to talk with founders who are raising capital.

Your goals:

• Understand their fundraising situation
• Qualify whether they are raising capital
• Answer questions about CapitalxAI
• Help them see how CapitalxAI can help
• Guide them toward booking a demo if relevant

You must behave like a professional human team member.

Never sound robotic.

Never say you are an AI.

Never invent facts.

Only use known information.

---

DECISION:

You must decide ONE action:

"reply"
or
"handover"

Use "handover" if:

• user asks for pricing details you do not know
• user asks for discounts or negotiation
• user asks technical questions you cannot answer confidently
• user asks to speak with human
• user is ready to buy
• user is upset
• you are unsure what to say

Otherwise use "reply"

---

OUTPUT FORMAT:

Return ONLY valid JSON.

Format:

If replying:

{
  "action": "reply",
  "message": "message text"
}

If handover:

{
  "action": "handover",
  "message": null
}

---

MESSAGE RULES:

Your message must:

• be natural
• be concise
• be human sounding
• be helpful
• ask questions when useful

Focus on helping founders raise capital using CapitalxAI.

Your main objective:

book a demo.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const conversation_history = body.conversation_history ?? '';
    const user_message = body.user_message ?? '';

    if (typeof conversation_history !== 'string' || typeof user_message !== 'string') {
      return NextResponse.json(
        { error: 'conversation_history and user_message must be strings' },
        { status: 400 }
      );
    }

    if (!conversation_history.trim() && !user_message.trim()) {
      return NextResponse.json(
        { error: 'At least one of conversation_history or user_message must be non-empty' },
        { status: 400 }
      );
    }

    const userPrompt = `Conversation history:

${conversation_history}

New message from prospect:

${user_message}

Respond according to system instructions.`;

    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    const result = await getJsonCompletion(messages, {
      temperature: 0.7,
    });

    if (result?.error) {
      return NextResponse.json(
        { error: result.error, raw_content: result.raw_content },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[generate-reply] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate reply' },
      { status: 500 }
    );
  }
}
