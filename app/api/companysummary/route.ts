// /app/api/companysummary/route.ts 
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const maxDuration = 100;

export async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).substring(2, 9);
  const log = (message: string, data?: any) => {
    console.log(`[${requestId}] ${message}`, data || '');
  };
  const errorLog = (message: string, error?: any) => {
    console.error(`[${requestId}] ERROR: ${message}`, error || '');
  };

  log('==> Starting company summary request');
  log('Environment variables:', {
    geminiKey: process.env.GEMINI_API_KEY ? 'Set' : 'Not set',
    nodeEnv: process.env.NODE_ENV,
  });

  try {
    let requestBody;
    try {
      requestBody = await req.json();
      log('Request body parsed successfully');
    } catch (parseError) {
      errorLog('Failed to parse request body', parseError);
      return NextResponse.json(
        { error: 'Invalid request body', requestId },
        { status: 400 }
      );
    }
    
    const { companyName, originalInput } = requestBody || {};
    
    if (!companyName) {
      console.error('No company name provided');
      return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    }

    if (!process.env.GEMINI_API_KEY) {
      const error = 'GEMINI_API_KEY environment variable is not set';
      errorLog(error);
      return NextResponse.json(
        { error, requestId },
        { status: 500 }
      );
    }

    let genAI;
    try {
      log('Initializing Google Generative AI client');
      genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    } catch (initError) {
      errorLog('Failed to initialize Google Generative AI client', initError);
      return NextResponse.json(
        { error: 'Failed to initialize AI client', requestId },
        { status: 500 }
      );
    }

    // Using gemini-pro as it's the stable model name
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    log('Using model:', 'gemini-pro');

    // For now, we'll use the company name as the main content
    // In a real implementation, you would fetch the company's website content here
    const companyInfo = `Company: ${companyName}\n` +
      `Original Input: ${originalInput || 'Not provided'}`;
      
    const mainpageText = companyInfo;

    const prompt = `You are an expert at writing important points about a company.
    Here is the information about a company:
    
    ${mainpageText}
    
    Based on this information, provide a summary with the following sections:
    - Company Overview
    - Main Products/Services
    - Target Market
    - Key Strengths
    - Industry Position
    - Additional Notes
    
    For each section, provide a brief 2-3 sentence description.
    If you don't have enough information for a section, you can skip it.
    
    Keep the language clear and professional.

    Use unique emojis for each heading.
    
    Output the result as a valid JSON object with a 'sections' array where each item has 'heading' and 'text' properties.`;

    log('Sending request to Gemini API');
    log('Prompt being sent:', { promptLength: prompt.length });
    let result;
    try {
      // Log the model configuration
      const generationConfig = {
        model: 'gemini-pro',
        temperature: 0.7,
        topK: 32,
        topP: 1,
        maxOutputTokens: 4096,
      };
      
      log('Model configuration:', generationConfig);
      log('Sending prompt to Gemini API. Prompt length:', prompt.length);
      
      const startTime = Date.now();
      const requestData = {
        contents: [{
          role: 'user',
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          topK: 32,
          topP: 1,
          maxOutputTokens: 4096,
        },
      };
      
      log('Sending request to Gemini API:', {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY ? '***' : 'MISSING'
        },
        data: JSON.stringify(requestData)
      });
      
      result = await model.generateContent(requestData);
      const endTime = Date.now();
      log(`Received response from Gemini API in ${endTime - startTime}ms`);
    } catch (error: any) {
      const apiError = error as Error & {
        code?: string;
        status?: number;
        response?: {
          data?: any;
          status?: number;
          headers?: Record<string, any>;
        };
        config?: {
          url?: string;
          method?: string;
          headers?: Record<string, any>;
        };
      };
      
      const errorDetails: Record<string, any> = {
        message: apiError.message,
        name: apiError.name,
        code: apiError.code,
        status: apiError.status,
        stack: process.env.NODE_ENV === 'development' ? apiError.stack : undefined,
      };
      
      // Add response details if available
      if (apiError.response) {
        errorDetails.responseData = apiError.response.data;
        errorDetails.statusCode = apiError.response.status;
        errorDetails.headers = apiError.response.headers;
      }
      
      errorLog('Gemini API request failed:', errorDetails);
      
      // Add config details if available
      if (apiError.config) {
        errorDetails.config = {
          url: apiError.config.url,
          method: apiError.config.method,
          headers: apiError.config.headers ? Object.keys(apiError.config.headers) : undefined
        };
      }
      
      // Check for common API key errors
      if (apiError.message.includes('API key not valid') || 
          apiError.message.includes('API_KEY_INVALID') ||
          apiError.message.includes('401')) {
        return NextResponse.json(
          { 
            error: 'Invalid API Key',
            details: 'The provided Gemini API key is invalid or has expired.',
            requestId,
            documentation: 'https://ai.google.dev/gemini-api/docs/authentication'
          },
          { status: 401 }
        );
      }
      
      return NextResponse.json(
        { 
          error: 'Failed to generate content',
          details: apiError.message || 'Unknown error occurred',
          requestId,
          documentation: 'https://ai.google.dev/gemini-api/docs/errors'
        },
        { status: 500 }
      );
    }

    let text;
    try {
      const response = result.response;
      text = await response.text();
      log('Successfully extracted text from response');
    } catch (textError) {
      errorLog('Failed to extract text from response', textError);
      return NextResponse.json(
        { 
          error: 'Failed to process AI response',
          details: 'Could not extract text from response',
          requestId 
        },
        { status: 500 }
      );
    }
    
    // Parse the response and validate against the schema
    let parsedResponse;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
      const jsonString = jsonMatch ? jsonMatch[1] : text;
      parsedResponse = JSON.parse(jsonString);
    } catch (e) {
      console.error('Failed to parse response as JSON:', e);
      // Fallback to trying to extract just the JSON part if parsing fails
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No valid JSON found in response');
        }
      } catch (err) {
        console.error('Failed to extract JSON from response:', err);
        throw new Error('Failed to parse model response as valid JSON');
      }
    }
    
    // Validate the parsed response against our schema
    const summarySchema = z.object({
      sections: z.array(z.object({
        heading: z.string(),
        text: z.string()
      }))
    });

    const validation = summarySchema.safeParse(parsedResponse);
    if (!validation.success) {
      console.error('Response validation failed:', validation.error);
      throw new Error('Invalid response format from model');
    }
    
    // Return the sections array from the validated response
    return NextResponse.json({ result: validation.data.sections });

  } catch (error) {
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error ? error.cause : undefined,
    };
    
    errorLog('Unhandled error in company summary API', errorDetails);
    
    return NextResponse.json({ 
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      requestId,
      timestamp: new Date().toISOString()
    }, { 
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      }
    });
  } finally {
    log('<== Completed company summary request');
  }
}