// CompanyResearchHome.tsx

"use client";
import { useState, FormEvent, useCallback } from "react";
import LinkedInDisplay from "./linkedin/LinkedinDisplay";
import CompetitorsDisplay from "./competitors/CompetitorsDisplay";
import NewsDisplay from "./news/NewsDisplay";
import CompanySummary from "./companycontent/CompanySummar";
import FundingDisplay from "./companycontent/FundingDisplay";
import ProfileDisplay from "./twitter/TwitterProfileDisplay";
import RecentTweetsDisplay from "./twitter/RecentTweetsDisplay";
import YoutubeVideosDisplay from "./youtube/YoutubeVideosDisplay";
import RedditDisplay from "./reddit/RedditDisplay";
import GitHubDisplay from "./github/GitHubDisplay";
import FinancialReportDisplay from './financial/FinancialReportDisplay';
import TikTokDisplay from './tiktok/TikTokDisplay';
import WikipediaDisplay from './wikipedia/WikipediaDisplay';
import CrunchbaseDisplay from './crunchbase/CrunchbaseDisplay';
import PitchBookDisplay from './pitchbook/PitchBookDisplay';
import TracxnDisplay from "./tracxn/TracxnDisplay";
import FoundersDisplay from "./founders/FoundersDisplay";
import {
  LinkedInSkeleton,
  YouTubeSkeleton,
  TikTokSkeleton,
  GitHubSkeleton,
  RedditSkeleton,
  TwitterSkeleton,
  CompetitorsSkeleton,
  NewsSkeleton,
  FoundersSkeleton,
  WikipediaSkeleton,
  FinancialSkeleton,
  FundingSkeleton,
  CompanySummarySkeleton,
} from "./skeletons/ResearchSkeletons";
import CompanyMindMap from './mindmap/CompanyMindMap';
import ExportCsvButton from './ui/ExportCsvButton';
import Link from "next/link";

// Import API functions
import {
  scrapeMainPage,
  fetchCompanyDetails,
  fetchCompetitors,
  fetchLinkedInData,
  fetchNews,
  fetchTwitterProfile,
  fetchYoutubeVideos,
  fetchRedditPosts,
  fetchGitHubUrl,
  fetchFunding,
  fetchFinancialReport,
  fetchTikTokProfile,
  fetchWikipedia,
  fetchCrunchbase,
  fetchPitchbook,
  fetchTracxn,
  fetchFounders
} from "../lib/api";

interface LinkedInData {
  text: string;
  url: string;
  image: string;
  title: string;
  [key: string]: any;
}

interface Video {
  id: string;
  url: string;
  title: string;
  author: string;
  [key: string]: any;
}

interface RedditPost {
  url: string;
  title: string;
  [key: string]: any;
}

interface Tweet {
  id: string;
  url: string;
  title: string;
  author: string;
  [key: string]: any;
}

interface Competitor {
  title: string;
  url: string;
  summary: string;
  [key: string]: any;
}

interface NewsItem {
  url: string;
  title: string;
  image: string;
  [key: string]: any;
}

interface Founder {
  url: string;
  title: string;
  [key: string]: any;
}

// Add new interface for company map data
interface CompanyMapData {
  companyName: string;
  rootNode: {
    title: string;
    children: Array<{
      title: string;
      description: string;
      children: Array<{
        title: string;
        description: string;
      }>;
    }>;
  };
}

// Utility functions
const extractDomain = (url: string): string | null => {
  if (!url) return null;
  try {
    // Remove protocol and www
    let domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    // Remove path and query string
    domain = domain.split('/')[0];
    // Remove port if present
    domain = domain.split(':')[0];
    return domain || null;
  } catch (e) {
    console.error('Error extracting domain:', e);
    return null;
  }
};

const parseCompanySize = (sizeStr: string): number => {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
};

const processLinkedInText = (data: any): { companySize: string } => {
  if (!data) return { companySize: '0' };
  // Extract company size from LinkedIn data
  const sizeMatch = data.text?.match(/(\d+(?:,\d+)*)\s+employees/i);
  return {
    companySize: sizeMatch ? sizeMatch[1].replace(/,/g, '') : '0'
  };
};

export default function CompanyResearcher() {
  // Company input and state
  const [rawCompanyInput, setRawCompanyInput] = useState('');
  const [submittedCompanies, setSubmittedCompanies] = useState<string[]>([]);
  const [activeCompany, setActiveCompany] = useState<string>('');
  const [isSearching, setIsSearching] = useState(false);
  const [companyUrl, setCompanyUrl] = useState(''); // Keep for backward compatibility
  
  // Results and errors by company
  const [resultsByCompany, setResultsByCompany] = useState<{
    [company: string]: {
      linkedinData: LinkedInData | null;
      competitors: Competitor[] | null;
      news: NewsItem[] | null;
      companySummary: any;
      twitterProfileText: any;
      recentTweets: Tweet[] | null;
      youtubeVideos: Video[] | null;
      redditPosts: RedditPost[] | null;
      githubUrl: string | null;
      fundingData: any;
      financialReport: any;
      tiktokData: any;
      wikipediaData: any;
      crunchbaseData: any;
      pitchbookData: any;
      tracxnData: any;
      founders: Founder[] | null;
      companyMap: CompanyMapData | null;
    }
  }>({});
  
  const [errorsByCompany, setErrorsByCompany] = useState<{[company: string]: Record<string, string>}>({});
  
  // Helper to get current company data
  const getCurrentCompanyData = useCallback((company: string) => {
    return resultsByCompany[company] || {
      linkedinData: null,
      competitors: null,
      news: null,
      companySummary: null,
      twitterProfileText: null,
      recentTweets: null,
      youtubeVideos: null,
      redditPosts: null,
      githubUrl: null,
      fundingData: null,
      financialReport: null,
      tiktokData: null,
      wikipediaData: null,
      crunchbaseData: null,
      pitchbookData: null,
      tracxnData: null,
      founders: null,
      companyMap: null
    };
  }, [resultsByCompany]);
  
  // Get data for active company
  const {
    linkedinData,
    competitors,
    news,
    companySummary,
    twitterProfileText,
    recentTweets,
    youtubeVideos,
    redditPosts,
    githubUrl,
    fundingData,
    financialReport,
    tiktokData,
    wikipediaData,
    crunchbaseData,
    pitchbookData,
    tracxnData,
    founders,
    companyMap
  } = activeCompany ? getCurrentCompanyData(activeCompany) : getCurrentCompanyData('');

  // Function to check if a string is a valid URL
  const isValidUrl = useCallback((url: string): boolean => {
    try {
      // Remove any whitespace
      url = url.trim();
      
      // Check if it's just a single word without dots
      if (!url.includes('.')) {
        return false;
      }

      // Add protocol if missing
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const urlObj = new URL(url);
      // Check if hostname has at least one dot and no spaces
      return urlObj.hostname.includes('.') && !urlObj.hostname.includes(' ');
    } catch {
      return false;
    }
  }, []);

  // Parse company input into array of company names
  const parseCompanyInput = useCallback((input: string): string[] => {
    return input
      .split(/[,\n]/) // Split by comma or newline
      .map(company => company.trim())
      .filter(company => company.length > 0) // Remove empty entries
      .filter((company, index, self) => 
        index === self.findIndex(c => c.toLowerCase() === company.toLowerCase()) // Deduplicate case-insensitive
      );
  }, []);

  // Research a single company
  const researchCompany = useCallback(async (company: string) => {
    const domainName = extractDomain(company);
    if (!domainName) {
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: { form: `Invalid company URL: ${company}. Please use format 'example.com'` }
      }));
      return;
    }

    // Initialize company data and clear previous errors
    setResultsByCompany(prev => ({
      ...prev,
      [company]: {
        linkedinData: null,
        competitors: null,
        news: null,
        companySummary: null,
        twitterProfileText: null,
        recentTweets: null,
        youtubeVideos: null,
        redditPosts: null,
        githubUrl: null,
        fundingData: null,
        financialReport: null,
        tiktokData: null,
        wikipediaData: null,
        crunchbaseData: null,
        pitchbookData: null,
        tracxnData: null,
        founders: null,
        companyMap: null
      }
    }));
    
    setErrorsByCompany(prev => ({
      ...prev,
      [company]: {}
    }));

    try {
      // Run all API calls in parallel
      const [
        mainPageData,
        linkedinData,
        newsData,
        twitterProfile,
        youtubeVideos,
        redditPosts,
        githubUrl,
        fundingData,
        financialReport,
        tiktokData,
        wikipediaData,
        crunchbaseData,
        pitchbookData,
        tracxnData,
        founders
      ] = await Promise.allSettled([
        // Main page scraping
        scrapeMainPage(domainName),
        
        // Independent API calls
        fetchLinkedInData(domainName),
        fetchNews(domainName),
        fetchTwitterProfile(domainName),
        fetchYoutubeVideos(domainName),
        fetchRedditPosts(domainName),
        fetchGitHubUrl(domainName),
        fetchFunding(domainName),
        fetchFinancialReport(domainName),
        fetchTikTokProfile(domainName),
        fetchWikipedia(domainName),
        fetchCrunchbase(domainName),
        fetchPitchbook(domainName),
        fetchTracxn(domainName),
        fetchFounders(domainName)
      ]);

      // Process main page data and dependent calls
      let companyDetails = null;
      let competitors = null;
      
      if (mainPageData.status === 'fulfilled' && mainPageData.value && mainPageData.value[0]?.summary) {
        try {
          companyDetails = await fetchCompanyDetails(mainPageData.value, domainName);
        } catch (error) {
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              companyDetails: error instanceof Error ? error.message : 'An error occurred with company details'
            }
          }));
        }

        try {
          competitors = await fetchCompetitors(mainPageData.value[0].summary, domainName);
        } catch (error) {
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              competitors: error instanceof Error ? error.message : 'An error occurred with competitors'
            }
          }));
        }
      } else if (mainPageData.status === 'rejected') {
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            websiteData: mainPageData.reason instanceof Error ? mainPageData.reason.message : 'An error occurred with website data'
          }
        }));
      }

      // Update results with all data
      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          ...(companyDetails && { companySummary: companyDetails }),
          ...(competitors && { competitors }),
          ...(linkedinData.status === 'fulfilled' && { linkedinData: linkedinData.value }),
          ...(newsData.status === 'fulfilled' && { news: newsData.value }),
          ...(twitterProfile.status === 'fulfilled' && { twitterProfileText: twitterProfile.value }),
          ...(youtubeVideos.status === 'fulfilled' && { youtubeVideos: youtubeVideos.value }),
          ...(redditPosts.status === 'fulfilled' && { redditPosts: redditPosts.value }),
          ...(githubUrl.status === 'fulfilled' && { githubUrl: githubUrl.value }),
          ...(fundingData.status === 'fulfilled' && { fundingData: fundingData.value }),
          ...(financialReport.status === 'fulfilled' && { financialReport: financialReport.value }),
          ...(tiktokData.status === 'fulfilled' && { tiktokData: tiktokData.value }),
          ...(wikipediaData.status === 'fulfilled' && { wikipediaData: wikipediaData.value }),
          ...(crunchbaseData.status === 'fulfilled' && { crunchbaseData: crunchbaseData.value }),
          ...(pitchbookData.status === 'fulfilled' && { pitchbookData: pitchbookData.value }),
          ...(tracxnData.status === 'fulfilled' && { tracxnData: tracxnData.value }),
          ...(founders.status === 'fulfilled' && { founders: founders.value })
        }
      }));

      // Handle errors for failed promises
      const handleError = (result: PromiseSettledResult<any>, key: string) => {
        if (result.status === 'rejected') {
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              [key]: result.reason instanceof Error ? result.reason.message : `An error occurred with ${key}`
            }
          }));
        }
      };

      handleError(linkedinData, 'linkedin');
      handleError(newsData, 'news');
      handleError(twitterProfile, 'twitter');
      handleError(youtubeVideos, 'youtube');
      handleError(redditPosts, 'reddit');
      handleError(githubUrl, 'github');
      handleError(fundingData, 'funding');
      handleError(financialReport, 'financial');
      handleError(tiktokData, 'tiktok');
      handleError(wikipediaData, 'wikipedia');
      handleError(crunchbaseData, 'crunchbase');
      handleError(pitchbookData, 'pitchbook');
      handleError(tracxnData, 'tracxn');
      handleError(founders, 'founders');

    } catch (error) {
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          general: error instanceof Error ? error.message : 'An unexpected error occurred'
        }
      }));
    }
  }, [activeCompany, resultsByCompany, setResultsByCompany, setErrorsByCompany]);

  // Main Research Function
  const handleResearch = useCallback(async (e: FormEvent) => {
    e.preventDefault();

    const companies = parseCompanyInput(rawCompanyInput);
    
    if (companies.length === 0) {
      setErrorsByCompany(prev => ({
        ...prev,
        _form: { form: 'Please enter at least one company URL' }
      }));
      return;
    }

    setIsSearching(true);
    setSubmittedCompanies(companies);
    setActiveCompany(companies[0]);
    
    // Clear previous results and errors for these companies
    setResultsByCompany(prev => {
      const newState = { ...prev };
      companies.forEach(company => {
        if (!newState[company]) {
          newState[company] = {
            linkedinData: null,
            competitors: null,
            news: null,
            companySummary: null,
            twitterProfileText: null,
            recentTweets: null,
            youtubeVideos: null,
            redditPosts: null,
            githubUrl: null,
            fundingData: null,
            financialReport: null,
            tiktokData: null,
            wikipediaData: null,
            crunchbaseData: null,
            pitchbookData: null,
            tracxnData: null,
            founders: null,
            companyMap: null
          };
        }
      });
      return newState;
    });
    
    setErrorsByCompany({});

    // Start research for all companies in parallel
    await Promise.all(companies.map(company => researchCompany(company)));
    
    setIsSearching(false);
  }, [rawCompanyInput, researchCompany, setIsSearching, setSubmittedCompanies, setActiveCompany, setResultsByCompany, setErrorsByCompany]);

  return (
    <div className="w-full max-w-5xl p-6 z-10 mb-20 mt-6">
      <h1 className="md:text-6xl text-4xl pb-5 font-medium opacity-0 animate-fade-up [animation-delay:200ms]">
        <span className="text-brand-default"> Company </span>
        Researcher
      </h1>

      <p className="text-black mb-12 opacity-0 animate-fade-up [animation-delay:400ms]">
        Enter company URLs (comma or newline separated) for detailed research. Instantly compare companies.
      </p>

      <form onSubmit={handleResearch} className="space-y-6 mb-8">
        <textarea
          value={rawCompanyInput}
          onChange={(e) => setRawCompanyInput(e.target.value)}
          placeholder="Enter company URLs (e.g., example.com, another-company.com)\nthird-company.com"
          rows={4}
          className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-brand-default resize-none opacity-0 animate-fade-up [animation-delay:600ms]"
        />
        <button
          type="submit"
          className={`w-full text-white font-semibold px-2 py-2 rounded-sm transition-opacity opacity-0 animate-fade-up [animation-delay:800ms] min-h-[50px] ${
            isSearching ? 'bg-gray-400' : 'bg-brand-default ring-2 ring-brand-default'
          } transition-colors`}
          disabled={isSearching}
        >
          {isSearching ? 'Researching...' : 'Research Companies'}
        </button>

        <div className="flex items-center justify-end gap-2 sm:gap-3 pt-4 opacity-0 animate-fade-up [animation-delay:1000ms]">
          <span className="text-gray-800">Powered by</span>
          <a 
            href="https://exa.ai" 
            target="_blank" 
            rel="origin"
            className="hover:opacity-80 transition-opacity"
          >
            <img src="/exa_logo.png" alt="Exa Logo" className="h-6 sm:h-7 object-contain" />
          </a>
        </div>
      </form>
      
      {/* Global loading indicator */}
      {isSearching && (
        <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm flex items-center gap-2">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
          <span>Gathering research data...</span>
        </div>
      )}
      
      {/* Tabs for companies */}
      {submittedCompanies.length > 0 && (
        <div className="mb-6 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 overflow-x-auto">
            {submittedCompanies.map((company, index) => (
              <button
                key={company}
                onClick={() => setActiveCompany(company)}
                className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${
                  activeCompany === company
                    ? 'border-brand-default text-brand-default'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {company}
                {errorsByCompany[company] && Object.keys(errorsByCompany[company]).length > 0 && (
                  <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    Error
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      )}
      
      {/* Display errors for the active company */}
      {activeCompany && errorsByCompany[activeCompany] && (
        <div className="space-y-2 mb-6">
          {Object.entries(errorsByCompany[activeCompany]).map(([key, message]) => (
            <div key={key} className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-sm">
              {key !== 'form' && <span className="font-medium">{key}: </span>}
              {message as string}
            </div>
          ))}
        </div>
      )}
      
      <div className="space-y-12">
        {/* Company Overview Section */}
        
          <div className="space-y-16">
          {(linkedinData || companySummary || founders || financialReport || 
          fundingData || crunchbaseData || pitchbookData || tracxnData || 
          wikipediaData) && (
            <div className="flex items-center">
              <h2 className="text-4xl font-medium">Company Overview</h2>
            </div>
            )}

            {isSearching && linkedinData === null ? (
              <LinkedInSkeleton />
            ) : linkedinData && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <LinkedInDisplay data={linkedinData} />
              </div>
            )}

            {isSearching && founders === null ? (
              <FoundersSkeleton />
            ) : founders && founders.length > 0 && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <FoundersDisplay founders={founders} />
              </div>
            )}

            {linkedinData && parseCompanySize(processLinkedInText(linkedinData).companySize) >= 1000 && (
              isSearching && financialReport === null ? (
                <FinancialSkeleton />
              ) : financialReport && (
                <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                  <FinancialReportDisplay report={financialReport} />
                </div>
              )
            )}

            <div className="space-y-6">
              {isSearching && fundingData === null ? (
                <FundingSkeleton />
              ) : fundingData && (
                <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                  <FundingDisplay fundingData={fundingData} />
                </div>
              )}

              {isSearching && crunchbaseData === null ? (
                <FundingSkeleton />
              ) : crunchbaseData && (
                <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                  <CrunchbaseDisplay data={crunchbaseData} />
                </div>
              )}

              {isSearching && pitchbookData === null ? (
                <FundingSkeleton />
              ) : pitchbookData && (
                <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                  <PitchBookDisplay data={pitchbookData} />
                </div>
              )}

              {isSearching && tracxnData === null ? (
                <FundingSkeleton />
              ) : tracxnData && (
                <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                  <TracxnDisplay data={tracxnData} />
                </div>
              )}
            </div>

            {isSearching && wikipediaData === null ? (
              <WikipediaSkeleton />
            ) : wikipediaData && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <WikipediaDisplay data={wikipediaData} websiteUrl={companyUrl} />
              </div>
            )}

            {isSearching && competitors === null ? (
              <CompetitorsSkeleton />
            ) : competitors && competitors.length > 0 && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <CompetitorsDisplay competitors={competitors} />
              </div>
            )}

            {isSearching && news === null ? (
              <NewsSkeleton />
            ) : news && news.length > 0 && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <NewsDisplay news={news} />
              </div>
            )}
          </div>
      

        {/* Company Socials Section */}
          <div className="space-y-16 pt-12">

          {(twitterProfileText || youtubeVideos || /* tiktokData || */
          redditPosts || githubUrl) && (
            <div className="flex items-center">
              <h2 className="text-4xl font-medium">Company Socials</h2>
            </div>
            )}

            {isSearching && youtubeVideos === null ? (
              <YouTubeSkeleton />
            ) : youtubeVideos && youtubeVideos.length > 0 && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <YoutubeVideosDisplay videos={youtubeVideos} />
              </div>
            )}

            {isSearching && redditPosts === null ? (
              <RedditSkeleton />
            ) : redditPosts && redditPosts.length > 0 && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <RedditDisplay posts={redditPosts} />
              </div>
            )}

            {/* {isSearching && tiktokData === null ? (
              <TikTokSkeleton />
            ) : tiktokData && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <TikTokDisplay data={tiktokData} />
              </div>
            )} */}

            {isSearching && githubUrl === null ? (
              <GitHubSkeleton />
            ) : githubUrl && (
              <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                <GitHubDisplay githubUrl={githubUrl} />
              </div>
            )}
          </div>
        

        {/* Summary and Mind Map Section */}
        {(isSearching || companySummary) && (
              <div className="space-y-8">
                <div className="flex items-center">
                  <h2 className="text-3xl font-medium mt-6">Summary and Mind Map</h2>
                </div>

                {isSearching && companySummary === null ? (
                  <CompanySummarySkeleton />
                ) : companySummary && (
                  <div className="opacity-0 animate-fade-up [animation-delay:200ms]">
                    <CompanySummary summary={companySummary} />
                  </div>
                )}

                {isSearching && companyMap === null ? (
                  <div className="hidden sm:block animate-pulse">
                    <div className="h-64 bg-secondary-darkest rounded-lg flex items-center justify-center">
                      <p className="text-gray-400 text-md">Loading...</p>
                    </div>
                  </div>
                ) : companyMap && (
                  <div className="hidden sm:block opacity-0 animate-fade-up [animation-delay:200ms]">
                    <CompanyMindMap data={companyMap} />
                  </div>
                )}
              </div>
            )}

      </div>
      
      {/* Export CSV Button */}
      <ExportCsvButton 
        companies={submittedCompanies.map(companyName => ({
          companyName,
          data: resultsByCompany[companyName] || {}
        }))}
      />
    </div>  
  );
}