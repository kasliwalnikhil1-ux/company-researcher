import { NextRequest, NextResponse } from 'next/server';
import { fetchInstagramProfile, extractUsernameFromUrl, qualifyInstagramProfile, InstagramProfileResponse } from '../../../utils/instagramApi';
import { createClient } from '@supabase/supabase-js';

// Helper function to get Supabase client for server-side operations
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('Supabase credentials not configured for server-side operations');
    return null;
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Helper function to fetch personalization settings
async function fetchPersonalizationSettings(userId: string | null): Promise<{ systemPrompt?: string; userMessage?: string } | null> {
  if (!userId) {
    return null;
  }

  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return null;
    }

    const { data, error } = await supabase
      .from('user_settings')
      .select('personalization')
      .eq('id', userId)
      .single();

    // PGRST116 = no rows returned (user hasn't set personalization yet)
    if (error && error.code === 'PGRST116') {
      // No personalization set yet, return null to use defaults
      return null;
    }

    if (error || !data?.personalization) {
      // Other error or no personalization data
      return null;
    }

    const personalization = typeof data.personalization === 'string'
      ? JSON.parse(data.personalization)
      : data.personalization;

    if (personalization?.instagram?.systemPrompt || personalization?.instagram?.userMessage) {
      return {
        systemPrompt: personalization.instagram.systemPrompt,
        userMessage: personalization.instagram.userMessage,
      };
    }

    return null;
  } catch (error) {
    console.error('Error fetching personalization settings:', error);
    return null;
  }
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    console.log('[Instagram Profile API] Request received');
    const body = await req.json();
    console.log('[Instagram Profile API] Request body:', body);
    const { instagramUrl, instagramUrls, username, usernames, userId, personalization } = body;
    
    // Support both single URL/username and multiple URLs/usernames
    let usernamesToFetch: string[] = [];
    
    if (instagramUrls && Array.isArray(instagramUrls)) {
      // Extract usernames from URLs
      usernamesToFetch = instagramUrls
        .map((url: string) => extractUsernameFromUrl(url))
        .filter((u: string | null): u is string => u !== null);
    } else if (instagramUrl) {
      const extracted = extractUsernameFromUrl(instagramUrl);
      if (extracted) {
        usernamesToFetch = [extracted];
      }
    } else if (usernames && Array.isArray(usernames)) {
      usernamesToFetch = usernames.filter((u: string) => u && u.trim().length > 0);
    } else if (username) {
      usernamesToFetch = [username.replace('@', '')];
    } else {
      return NextResponse.json({ error: 'Instagram URL or username is required' }, { status: 400 });
    }

    if (usernamesToFetch.length === 0) {
      console.error('[Instagram Profile API] No valid usernames found');
      return NextResponse.json({ error: 'At least one valid Instagram username is required' }, { status: 400 });
    }

    console.log(`[Instagram Profile API] Fetching profiles for usernames: ${usernamesToFetch.join(', ')}`);

    // Use passed personalization settings if available, otherwise fetch from database
    let personalizedPrompts = personalization;
    if (!personalizedPrompts) {
      personalizedPrompts = await fetchPersonalizationSettings(userId || null);
    }

    // Fetch profiles and qualify them for all usernames
    const results = await Promise.all(
      usernamesToFetch.map(async (username) => {
        try {
          const profileResponse = await fetchInstagramProfile(username);
          
          // Qualify the Instagram profile using Azure OpenAI with personalized prompts
          let qualificationData = null;
          try {
            console.log(`[Instagram Profile API] Qualifying profile for ${username}`);
            qualificationData = await qualifyInstagramProfile(profileResponse, 'azure', personalizedPrompts || undefined);
            console.log(`[Instagram Profile API] Qualification complete for ${username}:`, qualificationData.classification);
          } catch (qualError) {
            console.error(`[Instagram Profile API] Error qualifying profile for ${username}:`, qualError);
            // Don't fail the entire request if qualification fails, just log it
          }
          
          return {
            ...profileResponse.result,
            username,
            qualificationData,
          };
        } catch (error) {
          console.error(`Error fetching Instagram profile for ${username}:`, error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            username,
            error: errorMessage,
          };
        }
      })
    );

    // If single username, return single result
    if (usernamesToFetch.length === 1) {
      const result = results[0];
      if ('error' in result) {
        return NextResponse.json(
          { error: result.error, username: result.username },
          { status: 500 }
        );
      }
      return NextResponse.json(result);
    }

    // Return array of results
    return NextResponse.json(results);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Instagram profile API error:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      
      return NextResponse.json({ 
        error: 'Instagram profile API Failed',
        details: error.message,
        type: error.name
      }, { 
        status: 500 
      });
    }
    
    console.error('Unexpected error type:', error);
    const errorString = String(error);
    
    return NextResponse.json({ 
      error: 'Unexpected error occurred',
      details: errorString
    }, { 
      status: 500 
    });
  }
}

