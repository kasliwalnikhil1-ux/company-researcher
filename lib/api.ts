// API client for fetching company qualification data

export const fetchCompanyMap = async (domain: string): Promise<any> => {
  try {
    const response = await fetch('/api/companymap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        websiteurl: domain
      }),
    });
    
    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = `Failed to fetch company qualification data (${response.status})`;
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
        // If response is not JSON, use status text
        errorMessage = response.statusText || errorMessage;
      }
      
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}. ${errorDetails}`
        : errorMessage;
      
      console.error(`API Error for ${domain}:`, fullErrorMessage, `Status: ${response.status}`);
      return null;
    }
    
    return await response.json();
  } catch (error) {
    // Handle network errors or other exceptions
    if (error instanceof TypeError && error.message.includes('fetch')) {
      console.error('Network error fetching company qualification:', error);
    } else {
      console.error('Error fetching company qualification:', error);
    }
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