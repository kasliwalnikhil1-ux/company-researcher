// /app/api/companymap/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const maxDuration = 100;

// Check if API key is available
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Using fallback data.');
}

// Fallback data when API key is not available
const FALLBACK_MINDMAP = {
  companyName: 'Example Company',
  rootNode: {
    title: 'Main Product/Service',
    children: [
      {
        title: 'Core Products',
        description: 'Main offerings and services',
        children: [
          { title: 'Product 1', description: 'Description of product 1' },
          { title: 'Product 2', description: 'Description of product 2' }
        ]
      },
      {
        title: 'Technology',
        description: 'Key technologies used',
        children: [
          { title: 'Frontend', description: 'Frontend technologies' },
          { title: 'Backend', description: 'Backend technologies' }
        ]
      }
    ]
  }
};

export async function POST(req: NextRequest) {
  try {
    const { mainpage, websiteurl } = await req.json();
    
    if (!mainpage) {
      return NextResponse.json({ error: 'Mainpage content is required' }, { status: 400 });
    }

    // If no API key, return fallback data
    if (!GEMINI_API_KEY) {
      return NextResponse.json(FALLBACK_MINDMAP);
    }

    const mainpageText = JSON.stringify(mainpage, null, 2);

    // Define a recursive schema for mind map nodes
    const mindMapNodeSchema = z.object({
      title: z.string(),
      children: z.array(z.object({
        title: z.string(),
        description: z.string(),
        children: z.array(z.object({
          title: z.string(),
          description: z.string()
        }))
      }))
    });

    const mindMapSchema = z.object({
      companyName: z.string(),
      rootNode: mindMapNodeSchema
    });

    // Initialize the Google Generative AI client
    console.log('Initializing Google Generative AI with API key:', GEMINI_API_KEY ? '***key set***' : 'no key');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    
    console.log('Sending request to Gemini API...');

    const prompt = `You are an expert at creating insightful mind maps about companies.
    
    MAIN WEBSITE CONTENT:
    ${mainpageText}

    Create a mind map for the company at ${websiteurl}. The mind map should:
    1. Have exactly 3 levels of depth
    2. Start with the company's main focus/product as the central node
    3. Branch into 3-4 main categories (Level 1) such as:
       - Core Products/Services
       - Technology/Innovation
       - Market Position/Partnerships
       - Company Mission/Values
    4. Each Level 1 category should have 2-3 subcategories (Level 2)
    5. Each Level 2 subcategory should have a clear description
    
    Keep all text concise and easy to understand. Focus on the most important aspects that would help someone quickly grasp what the company does and why it matters.
    
    Format the response as a valid JSON object with this exact structure:
    {
      "companyName": "Company Name",
      "rootNode": {
        "title": "Main Focus/Product",
        "children": [
          {
            "title": "Category 1",
            "description": "Description of category 1",
            "children": [
              {
                "title": "Subcategory 1.1",
                "description": "Description of subcategory 1.1"
              },
              {
                "title": "Subcategory 1.2",
                "description": "Description of subcategory 1.2"
              }
            ]
          },
          // More categories...
        ]
      }
    }`;

    let result;
    try {
      result = await model.generateContent({
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
      });
      console.log('Received response from Gemini API');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorName = error instanceof Error ? error.name : 'Error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      console.error('Error calling Gemini API:', error);
      console.error('Error details:', {
        message: errorMessage,
        name: errorName,
        stack: errorStack,
        // @ts-ignore - These properties might exist on some error types
        status: (error as any)?.status,
        // @ts-ignore
        response: (error as any)?.response?.data
      });
      throw new Error(`Failed to generate content: ${errorMessage}`);
    }

    const response = result.response;
    let text;
    try {
      text = await response.text();
      
      // Parse the response text as JSON
      let jsonResponse;
      try {
        // Extract JSON from markdown code block if present
        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        const jsonString = jsonMatch ? jsonMatch[1] : text;
        jsonResponse = JSON.parse(jsonString);
      } catch (e) {
        console.error('Failed to parse response as JSON:', e);
        console.error('Raw response:', text);
        return NextResponse.json(FALLBACK_MINDMAP);
      }

      // Validate the parsed response against our schema
      const validation = mindMapSchema.safeParse(jsonResponse);
      if (!validation.success) {
        console.error('Response validation failed:', validation.error);
        console.error('Raw response:', jsonResponse);
        return NextResponse.json(FALLBACK_MINDMAP);
      }
      
      console.log('Generated mind map data:', validation.data);
      return NextResponse.json(validation.data);
    } catch (error) {
      console.error('Error processing AI response:', error);
      return NextResponse.json(FALLBACK_MINDMAP);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Company mind map API error:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
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
    return NextResponse.json({ 
      error: 'Unexpected error occurred',
      details: String(error)
    }, { 
      status: 500 
    });
  }
}