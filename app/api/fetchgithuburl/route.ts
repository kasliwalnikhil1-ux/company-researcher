// app/api/fetchgithuburl/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Exa from "exa-js";

export const maxDuration = 60;

const exaApiKey = process.env.EXA_API_KEY;

if (!exaApiKey) {
  console.error('EXA_API_KEY is not set in environment variables');
}

const exa = exaApiKey ? new Exa(exaApiKey) : null;

export async function POST(req: NextRequest) {
  try {
    if (!exa) {
      return NextResponse.json(
        { error: 'Server configuration error: EXA_API_KEY is not configured' },
        { status: 500 }
      );
    }

    const { websiteurl } = await req.json();

    if (!websiteurl) {
      return NextResponse.json(
        { error: 'websiteurl is required' },
        { status: 400 }
      );
    }

    console.log(`Searching for GitHub URL for: ${websiteurl}`);
    
    const result = await exa.search(
      `${websiteurl} Github:`,
      {
        type: "keyword",
        numResults: 1,
        includeDomains: ["github.com"]
      }
    );

    console.log(`GitHub search results for ${websiteurl}:`, result.results);
    return NextResponse.json({ results: result.results });
  } catch (error) {
    console.error('Error in fetchgithuburl API route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to perform search',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}