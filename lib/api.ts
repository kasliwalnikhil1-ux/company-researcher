// API client for fetching company data

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

// Mock implementation of API functions
// In a real app, these would make actual API calls
export const scrapeMainPage = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve([{ summary: 'Sample company summary' }]);
};

export const fetchCompanyDetails = async (data: any, domain: string): Promise<Array<{heading: string, text: string}>> => {
  // Mock implementation - returning data in the format expected by CompanySummary
  return Promise.resolve([
    {
      heading: "About",
      text: `${domain} is a leading company in its industry, known for innovative solutions and strong market presence.`
    },
    {
      heading: "History",
      text: `Founded in the early 2000s, ${domain} has grown from a small startup to a market leader.`
    },
    {
      heading: "Products",
      text: `${domain} offers a range of products and services designed to meet the needs of modern businesses.`
    }
  ]);
};

export const fetchCompetitors = async (summary: string, domain: string): Promise<Array<{title: string, url: string, summary: string}>> => {
  // Mock implementation - in a real app, this would be an API call
  return Promise.resolve([
    { 
      title: 'Competitor 1', 
      url: 'https://competitor1.com',
      summary: 'Competitor 1 is a leading company in the industry, known for innovative solutions.'
    },
    { 
      title: 'Competitor 2', 
      url: 'https://competitor2.com',
      summary: 'Competitor 2 provides cutting-edge technology and services in the market.'
    },
  ]);
};

export const fetchLinkedInData = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    text: 'Sample LinkedIn data',
    url: `https://linkedin.com/company/${domain}`,
    image: '',
    title: `${domain} | LinkedIn`
  });
};

export const fetchNews = async (domain: string): Promise<any[]> => {
  // Mock implementation
  return Promise.resolve([
    { title: 'Sample News 1', url: 'https://example.com/news1', image: '' },
    { title: 'Sample News 2', url: 'https://example.com/news2', image: '' },
  ]);
};

export const fetchTwitterProfile = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    name: domain,
    username: `@${domain}`,
    followers: 1000,
    // Add other Twitter profile data
  });
};

export const fetchYoutubeVideos = async (domain: string): Promise<any[]> => {
  // Mock implementation with properly formatted YouTube URLs
  return Promise.resolve([
    { 
      id: 'dQw4w9WgXcQ', 
      title: 'Sample Video 1', 
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 
      author: domain 
    },
    { 
      id: 'oHg5SJYRHA0', 
      title: 'Sample Video 2', 
      url: 'https://youtu.be/oHg5SJYRHA0', 
      author: domain 
    },
  ]);
};

export const fetchRedditPosts = async (domain: string): Promise<any[]> => {
  // Mock implementation
  return Promise.resolve([
    { title: 'Sample Reddit Post 1', url: 'https://reddit.com/post1' },
    { title: 'Sample Reddit Post 2', url: 'https://reddit.com/post2' },
  ]);
};

export const fetchGitHubUrl = async (domain: string): Promise<string | null> => {
  try {
    const response = await fetch('/api/fetchgithuburl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ websiteurl: domain }),
    });

    if (!response.ok) {
      console.error('Failed to fetch GitHub URL:', await response.text());
      return null;
    }

    const data = await response.json();
    // Return the first result's URL if available
    return data.results?.[0]?.url || null;
  } catch (error) {
    console.error('Error fetching GitHub URL:', error);
    return null;
  }
};

export const fetchFunding = async (domain: string): Promise<{ summary: string; url: string; favicon?: string }> => {
  // Mock implementation - returning data in the expected format
  return Promise.resolve({
    summary: "The company has raised a total of $1,000,000 across 2 funding rounds: $500,000 in Seed (Jan 2023) and $500,000 in Series A (Jun 2023).",
    url: `https://example.com/funding/${domain}`,
    favicon: `https://${domain}/favicon.ico`
  });
};

export const fetchFinancialReport = async (domain: string): Promise<Array<{
  id: string;
  url: string;
  title: string;
  author: string | null;
}>> => {
  // Mock implementation - return an array of financial reports
  return Promise.resolve([
    {
      id: '1',
      url: `https://example.com/financials/${domain}/2023`,
      title: '2023-Annual-Report-10K',
      author: null
    },
    {
      id: '2',
      url: `https://example.com/financials/${domain}/2022`,
      title: '2022-Annual-Report-10K',
      author: null
    }
  ]);
};

export const fetchTikTokProfile = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    username: `@${domain}`,
    followers: 5000,
    // Add other TikTok data
  });
};

export const fetchWikipedia = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    title: domain,
    extract: 'Sample Wikipedia extract about the company',
    url: `https://wikipedia.org/wiki/${domain}`,
  });
};

export const fetchCrunchbase = async (domain: string): Promise<{ url: string; title: string } | null> => {
  try {
    const response = await fetch('/api/fetchcrunchbase', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ websiteurl: domain }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform the API response to match the expected format
    if (data.results && data.results.length > 0) {
      return {
        url: data.results[0].url,
        title: data.results[0].title
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching Crunchbase data:', error);
    return null;
  }
};

export const fetchPitchbook = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    name: domain,
    valuation: 10000000,
    // Add other Pitchbook data
  });
};

export const fetchTracxn = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    name: domain,
    description: 'Sample Tracxn data',
    // Add other Tracxn data
  });
};

export const fetchFounders = async (domain: string): Promise<Array<{name: string, title: string, url: string}>> => {
  // Return empty array if no domain is provided
  if (!domain) return [];
  
  // Create LinkedIn search URLs for CEO and CTO
  const companyName = domain.replace(/^www\.|\.com$/g, '').replace(/\./g, ' ');
  const linkedinSearchBase = 'https://www.linkedin.com/search/results/people/';
  
  return [
    { 
      name: 'CEO', 
      title: 'CEO', 
      url: `${linkedinSearchBase}?keywords=${encodeURIComponent(companyName)}%20CEO&origin=GLOBAL_SEARCH_HEADER` 
    },
    { 
      name: 'CTO', 
      title: 'CTO', 
      url: `${linkedinSearchBase}?keywords=${encodeURIComponent(companyName)}%20CTO&origin=GLOBAL_SEARCH_HEADER` 
    }
  ];
};

export const fetchCompanyMap = async (domain: string, mainPageData: any): Promise<any> => {
  try {
    const response = await fetch('/api/companymap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        websiteurl: domain,
        mainpage: mainPageData 
      }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch company map data');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching company map:', error);
    return null;
  }
};
