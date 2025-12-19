// /app/api/companymap/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const maxDuration = 100;

export async function POST(req: NextRequest) {
  try {
    const { mainpage, websiteurl } = await req.json();
    
    if (!mainpage) {
      return NextResponse.json({ error: 'Mainpage content is required' }, { status: 400 });
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
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

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

    const result = await model.generateContent({
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

    const response = result.response;
    const text = response.text();
    
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
    const validation = mindMapSchema.safeParse(parsedResponse);
    if (!validation.success) {
      console.error('Response validation failed:', validation.error);
      throw new Error('Invalid response format from model');
    }
    
    console.log(validation.data);
    return NextResponse.json({ result: validation.data });

  } catch (error) {
    console.error('Company mind map API error:', error);
    return NextResponse.json({ error: `Company mind map API Failed | ${error}` }, { status: 500 });
  }
}