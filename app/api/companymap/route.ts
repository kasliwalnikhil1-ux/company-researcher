// /app/api/companymap/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Exa from "exa-js";

export const maxDuration = 100;

// Multiple Exa API keys from environment variable
const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map(key => key.trim()).filter(key => key.length > 0)
  : [];

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Helper function to send Slack notification
async function sendSlackNotification(message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
    return;
  }

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: message,
      }),
    });
  } catch (error) {
    console.error('Failed to send Slack notification:', error);
  }
}

// Helper function to check if error is due to insufficient credits
function isCreditError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('credit') ||
      message.includes('quota') ||
      message.includes('limit') ||
      message.includes('insufficient') ||
      message.includes('429') ||
      message.includes('403')
    );
  }
  return false;
}

// Helper function to create Exa client with a key
function createExaClient(key: string): Exa {
  return new Exa(key);
}

// Helper function to make Exa API call with a specific key
async function makeExaCall(
  url: string,
  key: string,
  query: string,
  schema: any
): Promise<any> {
  try {
    const exa = createExaClient(key);
    const response = await exa.getContents(
      [url],
      {
        livecrawl: "fallback",
        summary: {
          query,
          schema
        },
        text: true
      }
    );
    
    // Log response structure for debugging
    if (!response || (!response.results && !Array.isArray(response))) {
      console.warn(`Exa API returned unexpected structure for ${url}:`, {
        hasResults: !!response?.results,
        isArray: Array.isArray(response),
        responseType: typeof response,
        responseKeys: response ? Object.keys(response) : 'null/undefined'
      });
    }
    
    return response;
  } catch (error) {
    console.error(`Exa API call with key failed for ${url}:`, error);
    throw error;
  }
}

// Process URLs with multiple keys
async function processUrlsWithKeys(
  urls: string[],
  query: string,
  schema: any
): Promise<any> {
  const numUrls = urls.length;
  const numKeys = EXA_API_KEYS.length;

  if (numKeys === 0) {
    const errorMessage = 'No API keys configured';
    sendSlackNotification(`❌ API Key Error\n${errorMessage}`).catch(
      (err) => console.error('Failed to send Slack notification:', err)
    );
    throw new Error(errorMessage);
  }

  // If URLs < keys: randomly pick a key and retry with others on credit failure
  if (numUrls < numKeys) {
    // Shuffle keys for random selection
    const shuffledKeys = [...EXA_API_KEYS].sort(() => Math.random() - 0.5);
    const failedKeys: string[] = [];

    for (const key of shuffledKeys) {
      try {
        console.log(`Trying API key (${shuffledKeys.indexOf(key) + 1}/${shuffledKeys.length})`);
        
        // Process all URLs with this key
        const results = await Promise.all(
          urls.map(url => makeExaCall(url, key, query, schema))
        );

        return results.length === 1 ? results[0] : results;
      } catch (error) {
        if (isCreditError(error)) {
          console.warn(`Key failed due to credits, trying next key...`);
          const errorMessage = error instanceof Error ? error.message : String(error);
          sendSlackNotification(`⚠️ API Key Credit Error\nKey index: ${shuffledKeys.indexOf(key) + 1}\nError: ${errorMessage}\nTrying next key...`).catch(
            (err) => console.error('Failed to send Slack notification:', err)
          );
          failedKeys.push(key);
          continue; // Try next key
        }
        // If it's not a credit error, send notification and throw it
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendSlackNotification(`❌ API Key Error\nKey index: ${shuffledKeys.indexOf(key) + 1}\nError: ${errorMessage}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        throw error;
      }
    }

    // All keys failed due to credits
    const errorMessage = `All ${failedKeys.length} API keys exhausted due to insufficient credits`;
    sendSlackNotification(`❌ All API Keys Exhausted\n${errorMessage}`).catch(
      (err) => console.error('Failed to send Slack notification:', err)
    );
    throw new Error(errorMessage);
  }

  // If URLs >= keys: run all keys in parallel, handling credit failures
  console.log(`Processing ${numUrls} URLs with ${numKeys} keys in parallel`);
  
  // Distribute URLs across keys
  const urlsPerKey = Math.ceil(numUrls / numKeys);
  const keyTasks: Promise<any>[] = [];
  const availableKeys = [...EXA_API_KEYS];

  for (let i = 0; i < numKeys && i * urlsPerKey < numUrls; i++) {
    const startIdx = i * urlsPerKey;
    const endIdx = Math.min(startIdx + urlsPerKey, numUrls);
    const urlsForThisKey = urls.slice(startIdx, endIdx);
    const key = availableKeys[i];

    const task = (async () => {
      try {
        const results = await Promise.all(
          urlsForThisKey.map(url => makeExaCall(url, key, query, schema))
        );
        return { success: true, results, keyIndex: i };
      } catch (error) {
        if (isCreditError(error)) {
          console.warn(`Key ${i + 1} failed due to credits, will retry with other keys`);
          const errorMessage = error instanceof Error ? error.message : String(error);
          sendSlackNotification(`⚠️ API Key Credit Error\nKey index: ${i + 1}\nError: ${errorMessage}\nWill retry with other keys`).catch(
            (err) => console.error('Failed to send Slack notification:', err)
          );
          return { success: false, error, keyIndex: i, urls: urlsForThisKey };
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendSlackNotification(`❌ API Key Error\nKey index: ${i + 1}\nError: ${errorMessage}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        throw error;
      }
    })();

    keyTasks.push(task);
  }

  // Wait for all parallel tasks
  const taskResults = await Promise.all(keyTasks);
  
  // Collect successful results and retry failed ones
  const successfulResults: any[] = [];
  const failedTasks: Array<{ urls: string[]; keyIndex: number }> = [];

  for (const result of taskResults) {
    if (result.success) {
      if (Array.isArray(result.results)) {
        successfulResults.push(...result.results);
      } else {
        successfulResults.push(result.results);
      }
    } else {
      failedTasks.push({ urls: result.urls, keyIndex: result.keyIndex });
    }
  }

  // Retry failed tasks with remaining keys
  if (failedTasks.length > 0) {
    const usedKeyIndices = new Set(
      taskResults.filter(r => r.success).map(r => r.keyIndex)
    );
    const remainingKeys = availableKeys.filter((_, idx) => !usedKeyIndices.has(idx));

    if (remainingKeys.length === 0) {
      const errorMessage = 'All API keys exhausted due to insufficient credits';
      sendSlackNotification(`❌ All API Keys Exhausted\n${errorMessage}`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      throw new Error(errorMessage);
    }

    console.log(`Retrying ${failedTasks.length} failed task(s) with ${remainingKeys.length} remaining key(s)`);

    for (const failedTask of failedTasks) {
      let retried = false;
      for (const retryKey of remainingKeys) {
        try {
          const retryResults = await Promise.all(
            failedTask.urls.map(url => makeExaCall(url, retryKey, query, schema))
          );
          if (Array.isArray(retryResults)) {
            successfulResults.push(...retryResults);
          } else {
            successfulResults.push(retryResults);
          }
          retried = true;
          break;
        } catch (error) {
          if (isCreditError(error)) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            sendSlackNotification(`⚠️ API Key Credit Error (Retry)\nKey index: ${availableKeys.indexOf(retryKey)}\nError: ${errorMessage}\nTrying next key...`).catch(
              (err) => console.error('Failed to send Slack notification:', err)
            );
            continue; // Try next remaining key
          }
          const errorMessage = error instanceof Error ? error.message : String(error);
          sendSlackNotification(`❌ API Key Error (Retry)\nKey index: ${availableKeys.indexOf(retryKey)}\nError: ${errorMessage}`).catch(
            (err) => console.error('Failed to send Slack notification:', err)
          );
          throw error;
        }
      }

      if (!retried) {
        const errorMessage = `Failed to process URLs with any available key`;
        sendSlackNotification(`❌ API Key Error\n${errorMessage}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        throw new Error(errorMessage);
      }
    }
  }

  return numUrls === 1 ? successfulResults[0] : successfulResults;
}

export async function POST(req: NextRequest) {
  try {
    const { websiteurl, websiteurls } = await req.json();
    
    // Support both single URL and multiple URLs
    let urls: string[] = [];
    if (websiteurls && Array.isArray(websiteurls)) {
      urls = websiteurls;
    } else if (websiteurl) {
      urls = [websiteurl];
    } else {
      return NextResponse.json({ error: 'Website URL is required' }, { status: 400 });
    }

    if (urls.length === 0) {
      return NextResponse.json({ error: 'At least one website URL is required' }, { status: 400 });
    }

    // Clean URLs to base domain (remove paths, query params, etc.)
    const cleanUrl = (url: string): string => {
      try {
        // Remove any whitespace
        url = url.trim();
        
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        
        // Parse URL to extract just the origin (protocol + hostname)
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        
        // Return base URL with protocol
        return `${urlObj.protocol}//${hostname}`;
      } catch (e) {
        // If parsing fails, just ensure protocol exists
        return url.startsWith('http') ? url : `https://${url}`;
      }
    };

    const normalizedUrls = urls.map(url => cleanUrl(url));

    console.log(`Making Exa API call(s) to ${normalizedUrls.length} URL(s)`);

    const query = "You are a sales qualification assistant for a company that sells an AI software service to fashion/apparel/jewelry BRANDS that sell PHYSICAL products.\n\nYour job: classify the input company as:\n- QUALIFIED (sells physical fashion/apparel/jewelry products)\n- NOT_QUALIFIED (does NOT sell physical products; or is software/SaaS/IT/service provider)\n- MAYBE (unclear)\n\nCRITICAL RULE:\nOnly mark QUALIFIED if the company sells PHYSICAL consumer products (apparel, jewelry, accessories, etc.) to customers.\nIf the company sells software, SaaS, IT services, consulting, agencies, marketplaces, manufacturing/export services, or is a tool/vendor/provider, it is NOT_QUALIFIED.\n\nReturn STRICT JSON only following the schema.\nQualification Rules\nQUALIFIED ✅\n\nMark QUALIFIED only if you see some evidence of physical product commerce in the profile, such as:\n- product categories mentioned in bio (e.g., \"shirts\", \"kurtas\", \"rings\", \"earrings\")\n- shop links, website links, or e-commerce indicators\n- product-focused content in bio\n- brand/store indicators\n- fashion/apparel/jewelry business signals\n- fashion/apparel/jewelry Manufacturer / exporter / OEM / ODM / supplier / wholesaler\n- fashion/apparel/jewelry marketplace indicators (e.g., \"shop on Amazon\", \"shop on Flipkart\", \"shop on Myntra\", \"shop on Etsy\")\n\nNOT_QUALIFIED ❌\n\nMark NOT_QUALIFIED if ANY are true:\n- Sells software subscription / Is SaaS / Is app / Is AI tool\n- \"We provide services to brands\" (not selling products, like IT services / marketing agency / consulting)\n\nOnly return product_types when classification = \"QUALIFIED\".\n\nproduct_types must be EXACTLY 2 items:\n- generic physical product types (e.g., \"earrings\", \"rings\", \"kurtas\", \"shirts\")\n- NOT \"apparel\", \"jewelry\", \"fashion\" (too broad)\n- NOT services (\"photoshoots\", \"videography\")\n- NOT software (\"platform\", \"tool\", \"API\")\n\nIf you cannot find 2 real product types on the website text, then:\n- classification must be MAYBE (not QUALIFIED)\n- product_types must be null\n- sales_opener_sentence: Message to send to founder, follow exact sentence structure, starting with I think your...\n\nemail and phone as strings if present on the website else null";

    const schema = {
      description: "Schema for company qualification assessment with classification and recommended actions",
      type: "object",
      required: ["company_summary",  "sales_opener_sentence", "company_industry", "classification", "confidence_score", "product_types", "sales_action", "email", "phone"],
      additionalProperties: false,
      properties: {
        company_summary: {
          type: "string",
          description: "Brief summary of the company"
        },
        company_industry: {
          type: "string",
          description: "Industry of the company like apparel, jewelry, fashion, etc."
        },
        sales_opener_sentence: {
          type: "string",
          description: "I think your [usp, specialization, history // anything ] unique/impressive/special/different/etc. We can use this to start the conversation. Follow the exact sentence structure. <10 words only"        },
        classification: {
          type: "string",
          enum: ["QUALIFIED", "NOT_QUALIFIED", "MAYBE"],
          description: "Qualification status of the company"
        },
        confidence_score: {
          type: "number",
          description: "Confidence level in the classification assessment"
        },
        product_types: {
          type: "array",
          description: "List of product types associated with the company",
          items: {
            type: "string"
          }
        },
        sales_action: {
          type: "string",
          enum: ["OUTREACH", "EXCLUDE", "PARTNERSHIP", "MANUAL_REVIEW"],
          description: "Recommended sales action to take"
        },
        email: {
          type: "string",
          description: "Email address if present on the website, else empty string"
        },
        phone: {
          type: "string",
          description: "Phone number if present on the website, else empty string"
        }
      }
    };

    // Process URLs with multi-key logic
    const result = await processUrlsWithKeys(normalizedUrls, query, schema);

    console.log('Received response from Exa API');
    console.log('Result type:', Array.isArray(result) ? 'array' : typeof result);
    console.log('Result structure:', JSON.stringify(result, null, 2).substring(0, 500));

    // Handle single result
    if (!Array.isArray(result)) {
      // Check if result is null or undefined
      if (!result) {
        console.error('Exa API returned null or undefined result');
        const errorMessage = 'No results returned from Exa API - API returned null/undefined';
        sendSlackNotification(`❌ Exa API Error\n${errorMessage}\nURL: ${normalizedUrls[0]}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ 
          error: errorMessage
        }, { 
          status: 500 
        });
      }

      // Check if result has results array
      if (!result.results || result.results.length === 0) {
        console.error('Exa API result structure:', {
          hasResults: !!result.results,
          resultsLength: result.results?.length,
          resultKeys: Object.keys(result || {}),
          resultType: typeof result
        });
        const errorMessage = 'No results returned from Exa API - The API response does not contain any results in the expected format';
        sendSlackNotification(`❌ Exa API Error\n${errorMessage}\nURL: ${normalizedUrls[0]}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ 
          error: 'No results returned from Exa API',
          details: 'The API response does not contain any results in the expected format'
        }, { 
          status: 500 
        });
      }

      const firstResult = result.results[0];
      
      if (!firstResult) {
        console.error('No first result found in results array');
        const errorMessage = 'No results returned from Exa API - The results array is empty';
        sendSlackNotification(`❌ Exa API Error\n${errorMessage}\nURL: ${normalizedUrls[0]}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ 
          error: 'No results returned from Exa API',
          details: 'The results array is empty'
        }, { 
          status: 500 
        });
      }
      
      if (!firstResult.summary) {
        console.error('No summary in first result:', {
          resultKeys: Object.keys(firstResult),
          resultStructure: JSON.stringify(firstResult, null, 2).substring(0, 500)
        });
        const errorMessage = 'No summary in Exa API response - The API response does not contain a summary field';
        sendSlackNotification(`❌ Exa API Error\n${errorMessage}\nURL: ${normalizedUrls[0]}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ 
          error: 'No summary in Exa API response',
          details: 'The API response does not contain a summary field'
        }, { 
          status: 500 
        });
      }

      // Parse the summary JSON string
      let summaryData;
      try {
        summaryData = JSON.parse(firstResult.summary);
      } catch (parseError) {
        console.error('Failed to parse summary JSON:', parseError);
        console.error('Raw summary:', firstResult.summary);
        const parseErrorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        sendSlackNotification(`❌ Exa API Parse Error\nFailed to parse summary data\nError: ${parseErrorMessage}\nURL: ${normalizedUrls[0]}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ 
          error: 'Failed to parse summary data',
          raw_summary: firstResult.summary
        }, { 
          status: 500 
        });
      }

      console.log('Parsed summary data:', summaryData);
      return NextResponse.json(summaryData);
    }

    // Handle multiple results
    const allResults = result.flatMap((r: any) => {
      // Handle case where r might be the result object directly
      if (r.results && Array.isArray(r.results)) {
        return r.results;
      }
      // Handle case where r itself might be a result
      if (r.summary) {
        return [r];
      }
      return [];
    });
    
    if (allResults.length === 0) {
      console.error('No results found in array response:', {
        resultLength: result.length,
        resultStructure: result.map((r: any) => ({
          hasResults: !!r.results,
          hasSummary: !!r.summary,
          keys: Object.keys(r || {})
        }))
      });
      const errorMessage = 'No results returned from Exa API - The API response array does not contain any valid results';
      sendSlackNotification(`❌ Exa API Error\n${errorMessage}\nURLs: ${normalizedUrls.join(', ')}`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      return NextResponse.json({ 
        error: 'No results returned from Exa API',
        details: 'The API response array does not contain any valid results'
      }, { 
        status: 500 
      });
    }

    // Parse all summaries
    const parsedResults = allResults.map((r: any, idx: number) => {
      if (!r.summary) {
        return { error: `No summary in result ${idx + 1}` };
      }
      try {
        return JSON.parse(r.summary);
      } catch (parseError) {
        console.error(`Failed to parse summary JSON for result ${idx + 1}:`, parseError);
        return { error: 'Failed to parse summary data', raw_summary: r.summary };
      }
    });

    return NextResponse.json(
      normalizedUrls.length === 1 ? parsedResults[0] : parsedResults
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Company mind map API error:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      
      // Send Slack notification for API errors
      sendSlackNotification(`❌ Company Mind Map API Error\nError: ${error.message}\nType: ${error.name}`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      
      return NextResponse.json({ 
        error: 'Company mind map API Failed',
        details: error.message,
        type: error.name
      }, { 
        status: 500 
      });
    }
    
    // Handle non-Error thrown values
    console.error('Unexpected error type:', error);
    const errorString = String(error);
    sendSlackNotification(`❌ Unexpected API Error\nError: ${errorString}`).catch(
      (err) => console.error('Failed to send Slack notification:', err)
    );
    
    return NextResponse.json({ 
      error: 'Unexpected error occurred',
      details: errorString
    }, { 
      status: 500 
    });
  }
}