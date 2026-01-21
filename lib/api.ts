// API client for fetching company qualification data

export const fetchCompanyMap = async (
  domain: string, 
  userId?: string | null,
  personalization?: { query?: string; schema?: any } | null
): Promise<any> => {
  try {
    const response = await fetch('/api/companymap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        websiteurl: domain,
        userId: userId || null,
        personalization: personalization || null
      }),
    });
    
    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = `Failed to fetch company qualification data (${response.status})`;
      let errorDetails = '';
      let errorData: any = null;
      try {
        errorData = await response.json();
        if (errorData.error || errorData.message) {
          errorMessage = errorData.error || errorData.message;
        }
        if (errorData.details) {
          errorDetails = errorData.details;
        }
      } catch (e) {
        // If response is not JSON, use status text
        errorMessage = response.statusText || errorMessage;
      }
      
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}. ${errorDetails}`
        : errorMessage;
      
      // Check if this is the "No results returned from Exa API" error with status 500
      // In this case, return an EXPIRED classification instead of null
      if (response.status === 500 && errorMessage.includes('No results returned from Exa API')) {
        console.warn(`Marking ${domain} as EXPIRED due to Exa API returning no results`);
        return {
          classification: 'EXPIRED',
          company_summary: '',
          company_industry: '',
          sales_opener_sentence: '',
          confidence_score: 0,
          product_types: null,
          sales_action: 'MANUAL_REVIEW'
        };
      }
      
      console.error(`API Error for ${domain}:`, fullErrorMessage, `Status: ${response.status}`);
      
      // Send Slack notification for API error
      const slackMessage = `❌ API Error for ${domain}\nStatus: ${response.status}\nError: ${fullErrorMessage}`;
      sendSlackNotification(slackMessage).catch(
        (slackError) => console.error('Failed to send Slack notification:', slackError)
      );
      
      return null;
    }
    
    return await response.json();
  } catch (error) {
    // Handle network errors or other exceptions
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof TypeError && error.message.includes('fetch') 
      ? 'Network error' 
      : 'Error';
    
    console.error(`${errorType} fetching company qualification:`, error);
    
    // Send Slack notification for network/other errors
    const slackMessage = `❌ ${errorType} for ${domain}\nError: ${errorMessage}`;
    sendSlackNotification(slackMessage).catch(
      (slackError) => console.error('Failed to send Slack notification:', slackError)
    );
    
    return null;
  }
};

// Send Slack notification
export const sendSlackNotification = async (message: string): Promise<boolean> => {
  try {
    const response = await fetch('/api/slack-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to send Slack notification');
    }
    
    return true;
  } catch (error) {
    console.error('Error sending Slack notification:', error);
    return false;
  }
};

// Fetch Instagram profile data
export const fetchInstagramProfile = async (
  instagramUrl: string, 
  userId?: string | null,
  personalization?: { systemPrompt?: string; userMessage?: string } | null
): Promise<any> => {
  try {
    const response = await fetch('/api/instagram-profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        instagramUrl: instagramUrl,
        userId: userId || null,
        personalization: personalization || null
      }),
    });
    
    if (!response.ok) {
      let errorMessage = `Failed to fetch Instagram profile (${response.status})`;
      let errorDetails = '';
      try {
        const errorData = await response.json();
        if (errorData.error || errorData.message) {
          errorMessage = errorData.error || errorData.message;
        }
        if (errorData.details) {
          errorDetails = errorData.details;
        }
      } catch (e) {
        errorMessage = response.statusText || errorMessage;
      }
      
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}. ${errorDetails}`
        : errorMessage;
      
      console.error(`Instagram API Error for ${instagramUrl}:`, fullErrorMessage, `Status: ${response.status}`);
      
      const slackMessage = `❌ Instagram API Error for ${instagramUrl}\nStatus: ${response.status}\nError: ${fullErrorMessage}`;
      sendSlackNotification(slackMessage).catch(
        (slackError) => console.error('Failed to send Slack notification:', slackError)
      );
      
      return null;
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof TypeError && error.message.includes('fetch') 
      ? 'Network error' 
      : 'Error';
    
    console.error(`${errorType} fetching Instagram profile:`, error);
    
    const slackMessage = `❌ ${errorType} for ${instagramUrl}\nError: ${errorMessage}`;
    sendSlackNotification(slackMessage).catch(
      (slackError) => console.error('Failed to send Slack notification:', slackError)
    );
    
    return null;
  }
};