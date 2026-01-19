import { NextRequest, NextResponse } from 'next/server';
import { fetchInstagramProfile, extractUsernameFromUrl, qualifyInstagramProfile, InstagramProfileResponse } from '../../../utils/instagramApi';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    console.log('[Instagram Profile API] Request received');
    const body = await req.json();
    console.log('[Instagram Profile API] Request body:', body);
    const { instagramUrl, instagramUrls, username, usernames } = body;
    
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

    // Fetch profiles and qualify them for all usernames
    const results = await Promise.all(
      usernamesToFetch.map(async (username) => {
        try {
          const profileResponse = await fetchInstagramProfile(username);
          
          // Qualify the Instagram profile using Azure OpenAI
          let qualificationData = null;
          try {
            console.log(`[Instagram Profile API] Qualifying profile for ${username}`);
            qualificationData = await qualifyInstagramProfile(profileResponse, 'azure');
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

