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

export const fetchCompanyDetails = async (data: any, domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    name: domain,
    description: 'Sample company description',
    // Add other company details
  });
};

export const fetchCompetitors = async (summary: string, domain: string): Promise<any[]> => {
  // Mock implementation
  return Promise.resolve([
    { name: 'Competitor 1', url: 'https://competitor1.com' },
    { name: 'Competitor 2', url: 'https://competitor2.com' },
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
  // Mock implementation
  return Promise.resolve([
    { id: '1', title: 'Sample Video 1', url: 'https://youtube.com/video1', author: domain },
    { id: '2', title: 'Sample Video 2', url: 'https://youtube.com/video2', author: domain },
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

export const fetchFunding = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    totalFunding: 1000000,
    fundingRounds: [
      { amount: 500000, date: '2023-01-01', round: 'Seed' },
      { amount: 500000, date: '2023-06-01', round: 'Series A' },
    ],
  });
};

export const fetchFinancialReport = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    revenue: 5000000,
    profit: 1000000,
    year: 2023,
    // Add other financial data
  });
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

export const fetchCrunchbase = async (domain: string): Promise<any> => {
  // Mock implementation
  return Promise.resolve({
    name: domain,
    description: 'Sample Crunchbase data',
    // Add other Crunchbase data
  });
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
  const linkedinSearchBase = 'https://www.linkedin.com/search/results/people/?';
  
  return [
    { 
      name: 'CEO', 
      title: 'CEO', 
      url: `${linkedinSearchBase}keywords=${encodeURIComponent(companyName)}%20CEO&origin=GLOBAL_SEARCH_HEADER` 
    },
    { 
      name: 'CTO', 
      title: 'CTO', 
      url: `${linkedinSearchBase}keywords=${encodeURIComponent(companyName)}%20CTO&origin=GLOBAL_SEARCH_HEADER` 
    }
  ];
};
