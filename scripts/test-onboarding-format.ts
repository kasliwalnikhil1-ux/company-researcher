/**
 * Test script: formats sample onboarding data and logs output.
 * Run: npx tsx scripts/test-onboarding-format.ts
 */
import { formatOnboardingCompanySummary } from '../lib/utils';

const sampleOnboarding = {
  step0: { primaryUse: 'fundraising' as const },
  step1: { gender: 'male', lastName: 'Kasliwal', firstName: 'Naman' },
  step2: { bio: 'IIT Bombay founders, ex-YC', title: 'CEO' },
  step3: { experience: 'getting_started' as const },
  step4: { capitalRaised: '2m_10m' as const },
  step5: { website: 'http://kaptured.ai', companyName: 'Kaptured AI' },
  step6: { sector: ['saas', 'retail-tech', 'artificial-intelligence'] },
  step7: { stage: 'pre-seed' },
  step8: { hqCountry: 'Bahamas' },
  step9: {
    productDescription:
      'Kaptured.AI offers a service that transforms products into stunning 4K images and videos using AI technology. The platform eliminates the need for physical models and studios, allowing for quick and consistent content creation that aligns with brand aesthetics.',
  },
  step10: {
    arr: [],
    revenueStatus: 'no' as const,
    customerDescription:
      'The customers of Kaptured.AI include brands and businesses in the fashion and e-commerce sectors looking to enhance their visual marketing through high-quality AI-generated content.',
  },
  step11: { lookingToRaiseFrom: ['Venture Capital', 'Angel Investor'], timeline: 'near_term' as const, targetRoundSize: 'less_than_500k' as const },
  step12: { investorType: 'both' as const },
  flowType: 'fundraising' as const,
  completed: true,
  completedAt: '2026-01-28T18:12:18.323Z',
};

console.log('=== formatOnboardingCompanySummary test ===\n');
const formatted = formatOnboardingCompanySummary(sampleOnboarding);
console.log('\n=== Formatted output ===\n');
console.log(formatted);
console.log('\n=== Done ===');
