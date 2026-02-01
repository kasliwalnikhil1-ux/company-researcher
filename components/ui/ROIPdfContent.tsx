'use client';

import React from 'react';
import { Check, Clock, Target, Zap, TrendingUp } from 'lucide-react';

export function ROIPdfContent() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 w-[794px]">
      <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2 mb-6">
        The ROI of
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="CapitalxAI" width={24} height={24} className="h-6 w-auto" />
        CapitalxAI
      </h2>

      <div className="space-y-6">
        <div className="rounded-xl bg-brand-default/10 border-2 border-brand-default/30 p-5">
          <p className="text-base font-semibold text-gray-900 leading-relaxed">
            💸 Fundraising Is About Momentum. More Meetings = More Yeses.
          </p>
          <p className="mt-2 text-base font-medium text-gray-900 leading-relaxed">
            If this helps you close just one investor meeting, it pays for itself.
          </p>
          <p className="mt-2 text-base font-medium text-gray-900 leading-relaxed">
            One investor can be worth $50k–$500k+ in funding. It can completely change the trajectory of your business.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3">We&apos;re offering</h3>
          <ul className="space-y-2">
            {[
              'Investor discovery',
              'Warm intro pathways',
              'AI-assisted outreach',
              'Relationship mapping',
              'Strategy guidance',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                <Check className="w-4 h-4 text-brand-default shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-gray-600">
            At <span className="font-semibold text-gray-900">$700 for 6 months</span>
          </p>
          <p className="mt-2 text-sm text-gray-600">
            That&apos;s comparable to: A junior fundraising analyst ($3k–$5k/month), a fundraising consultant ($5k–$15k), or months of manual outreach.
          </p>
        </div>

        <div className="rounded-lg bg-accent-darkgreen-light/50 border border-accent-darkgreen-dark/20 p-4">
          <h3 className="text-sm font-semibold text-accent-darkgreen-dark mb-2 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Fundraising ROI is massive
          </h3>
          <p className="text-sm text-gray-700">
            If a founder raises even $250k–$1M, and your platform helped them find the right investors faster — then $500–$700 is negligible.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <Clock className="w-4 h-4 text-brand-default" />
            Save 10–15 Hours Every Week
          </h3>
          <p className="text-sm text-gray-600 mb-2">
            Finding the right investors, researching them, and sourcing contacts usually takes 10+ hours/week. CapitalxAI automates 80% of that work.
          </p>
          <p className="text-sm font-medium text-gray-900">
            Result: If your time is worth just $100/hour, the Basic plan pays for itself in one week.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <Target className="w-4 h-4 text-brand-default" />
            Pitch the Right Investors (Not Everyone)
          </h3>
          <p className="text-sm text-gray-600 mb-2">
            Most founders waste time pitching investors who don&apos;t invest in their stage, sector, or region. CapitalxAI fixes this with investor intent & fit analysis, mutual interest detection, and smart filtering by thesis and activity.
          </p>
          <p className="text-sm font-medium text-gray-900">
            Result: Fewer pitches. More real conversations.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500" />
            More meetings → Faster fundraise
          </h3>
          <p className="text-sm text-gray-600 mb-2">
            Warm intros convert 10× better than cold emails. With Pro, you get founder–investor relationship mapping, shared connections & background signals, and social and portfolio-based context.
          </p>
          <p className="text-sm font-medium text-gray-900">
            Result: Outreach that feels warm, not random.
          </p>
        </div>

        <div className="rounded-xl bg-brand-default/10 border-2 border-brand-default/30 p-5">
          <p className="text-base font-semibold text-gray-900 leading-relaxed">
            💰 Super Intelligence for Fundraising
          </p>
          <p className="mt-2 text-base font-medium text-gray-900 leading-relaxed">
            One investor meeting can be worth $50K–$500K+ in funding. CapitalxAI helps you get there faster — for less than the cost of a single pitch deck revision.
          </p>
        </div>
      </div>
    </div>
  );
}
