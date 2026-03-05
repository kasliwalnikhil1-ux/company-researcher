import { NextRequest, NextResponse } from 'next/server';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';

export const maxDuration = 60;

const SYSTEM_MESSAGE = `You are a top-performing SDR writing a cold outbound email.

Generate:
First line to start the email
Must sound like a natural email opener
Do not sell, do not ask a question.
If more than 1 news is provided, pick just one.

- be natural
- be concise
- be human sounding
- Do not use em dashes
- Never invent facts.
- Only use known information.

First line to start email: (Start with a congratulatory or observational tone like "Congrats on...", less than 60 characters)
Subject line: (Written as if congratulatory or observational like "Congrats on...!", less than 60 characters)

Reply as a JSON:
{
  "first_line_to_start_email": "str",
  "subject_line": "str"
}`;

function normalizeLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const news = typeof body?.news === 'string' ? body.news.trim() : '';

    if (!news) {
      return NextResponse.json({ error: 'News text is required' }, { status: 400 });
    }

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: SYSTEM_MESSAGE },
        {
          role: 'user',
          content: `I will paste a news item below.\n\nNews:\n${news}`,
        },
      ],
      { max_tokens: 300 }
    );

    if (extracted?.error) {
      const errMsg = typeof extracted.error === 'string' ? extracted.error : 'AI generation failed';
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const firstLine = normalizeLine(extracted?.first_line_to_start_email);
    const subjectLine = normalizeLine(extracted?.subject_line);

    if (!firstLine || !subjectLine) {
      return NextResponse.json(
        { error: 'AI did not return valid first line and subject line.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      first_line_to_start_email: firstLine,
      subject_line: subjectLine,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'Failed to generate email opener from news.', details: msg },
      { status: 500 }
    );
  }
}
