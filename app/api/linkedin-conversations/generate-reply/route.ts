import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJsonCompletion, Message } from '@/utils/azureOpenAiHelper';
import {
  DEFAULT_LINKEDIN_GENERATE_REPLY_SYSTEM_PROMPT,
  DEFAULT_LINKEDIN_INTRO,
  DEFAULT_LINKEDIN_CONTEXT,
  DEFAULT_LINKEDIN_HANDOVER_RULES,
  buildLinkedinGenerateReplyPrompt,
} from '@/app/personalization/linkedinGenerateReplyDefault';

/** Auth client (anon key + user token) for verifying user identity */
function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Service client (service role key) for DB operations */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role environment variables');
  return createClient(url, key);
}

const VALID_STAGES = [
  'reply_received',
  'meeting_scheduled',
  'demo_completed',
  'proposal_sent',
  'negotiating',
  'closed_won',
  'closed_lost',
];

/** Fallback when personalization.linkedinConversations.systemPrompt is null */
const DEFAULT_SYSTEM_PROMPT = DEFAULT_LINKEDIN_GENERATE_REPLY_SYSTEM_PROMPT;

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = getAuthClient(accessToken);
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = userData.user.id;

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

    // Fetch personalization once (like onboarding from user_settings)
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const supabase = getServiceClient();
      const { data, error } = await supabase
        .from('user_settings')
        .select('personalization')
        .eq('id', userId)
        .single();

      if (!error && data?.personalization) {
        const personalization = typeof data.personalization === 'string'
          ? JSON.parse(data.personalization)
          : data.personalization;

        const lcRaw = personalization?.linkedinConversations;
        const lc = lcRaw && typeof lcRaw === 'object' ? lcRaw : null;

        let custom: string | null = null;

        if (lc) {
          const hasSegmentOverrides =
            (typeof lc.intro === 'string' && lc.intro.trim().length > 0) ||
            (typeof lc.context === 'string' && lc.context.trim().length > 0) ||
            (typeof lc.handoverRules === 'string' && lc.handoverRules.trim().length > 0);

          if (hasSegmentOverrides) {
            const intro =
              (typeof lc.intro === 'string' && lc.intro.trim()) || DEFAULT_LINKEDIN_INTRO;
            const context =
              (typeof lc.context === 'string' && lc.context.trim()) || DEFAULT_LINKEDIN_CONTEXT;
            const handoverRules =
              (typeof lc.handoverRules === 'string' && lc.handoverRules.trim()) ||
              DEFAULT_LINKEDIN_HANDOVER_RULES;

            custom = buildLinkedinGenerateReplyPrompt(intro, context, handoverRules);
          } else if (typeof lc.systemPrompt === 'string' && lc.systemPrompt.trim()) {
            // Backwards compatibility: use legacy full systemPrompt if present
            custom = lc.systemPrompt.trim();
          }
        }

        if (custom) {
          systemPrompt = custom;
        }
      }
    } catch (e) {
      console.warn('[generate-reply] Failed to fetch personalization, using default:', e);
    }

    const userPrompt = `Conversation history:

${conversation_history}

New message from prospect:

${user_message}

Respond according to system instructions.`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
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

    if (result?.stage && !VALID_STAGES.includes(result.stage)) {
      result.stage = 'reply_received';
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
