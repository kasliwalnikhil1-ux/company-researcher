/** Invented people and companies for the demo. No real person, brand or logo; photos are licensed stock portraits (seed/faces.ts). */

export const FIRST_NAMES = [
  'Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Isla', 'Mateo', 'Nora', 'Kai', 'Leah', 'Omar', 'Ruby', 'Jonas', 'Elena', 'Arjun',
  'Chloe', 'Felix', 'Hana', 'Diego', 'Maya', 'Theo', 'Sana', 'Lucas', 'Ines', 'Rohan', 'Clara', 'Malik', 'Ivy', 'Tomas', 'Amara', 'Ben',
  'Lena', 'Yusuf', 'Grace', 'Nico', 'Priya', 'Owen', 'Freya', 'Kenji', 'Lucia', 'Sami', 'Elise', 'Marco', 'Anya', 'Caleb', 'Tara', 'Hugo',
  'Nadia', 'Rafael', 'Josie', 'Dev', 'Mila', 'Aaron', 'Selin', 'Victor', 'Leila', 'Oscar', 'Keira', 'Idris',
];

/** Which first names get a woman's or a man's face (seed/faces.ts); a name in neither set gets one picked from its id. */
export const FEMALE_FIRST_NAMES = new Set([
  'Ava', 'Mia', 'Zoe', 'Isla', 'Nora', 'Leah', 'Ruby', 'Elena', 'Chloe', 'Hana', 'Maya', 'Sana', 'Ines', 'Clara', 'Ivy', 'Amara',
  'Lena', 'Grace', 'Priya', 'Freya', 'Lucia', 'Elise', 'Anya', 'Tara', 'Nadia', 'Josie', 'Mila', 'Selin', 'Leila', 'Keira',
  'Rosalind', 'Imogen', 'Wren',
]);
export const MALE_FIRST_NAMES = new Set([
  'Noah', 'Liam', 'Ethan', 'Mateo', 'Omar', 'Jonas', 'Arjun', 'Felix', 'Diego', 'Theo', 'Lucas', 'Rohan', 'Malik', 'Tomas', 'Ben',
  'Yusuf', 'Nico', 'Owen', 'Kenji', 'Marco', 'Caleb', 'Hugo', 'Rafael', 'Dev', 'Aaron', 'Victor', 'Oscar', 'Idris',
  'Kai', 'Sami', 'Teodor', 'Callum',
]);

export const LAST_NAMES = [
  'Hartley', 'Okafor', 'Lindqvist', 'Moreau', 'Castillo', 'Brennan', 'Achterberg', 'Nakamura', 'Ferreira', 'Kowalski', 'Haddad', 'Ostrowski',
  'Varga', 'Delacroix', 'Mensah', 'Sorensen', 'Albrecht', 'Quinlan', 'Patel', 'Rinaldi', 'Whitcombe', 'Dubois', 'Halloran', 'Ivanova',
  'Bergstrom', 'Mwangi', 'Ashford', 'Calloway', 'Fairbanks', 'Greenhalgh', 'Holloway', 'Iverson', 'Jaramillo', 'Kingsley', 'Larkspur',
  'Montague', 'Northcott', 'Oyelaran', 'Pemberton', 'Ravensworth', 'Sallow', 'Thistlewood', 'Underhill', 'Valdez', 'Wexford', 'Yardley',
];

/** Invented company names (checked to read as fictional). */
export const COMPANIES = [
  'Brightloop Analytics', 'Quarry & Finch', 'Tidewell Health', 'Northpeak Software', 'Lumenfield Labs', 'Copperline Studio', 'Velvet Orbit',
  'Saltmarsh Logistics', 'Glasshouse CRM', 'Pinecrest Payroll', 'Halcyon Freight', 'Mosswood Bio', 'Inkwell Media', 'Kitebridge AI',
  'Stonefruit Commerce', 'Bramble Finance', 'Harbor & Pine Realty', 'Driftwood Robotics', 'Cinderwake Games', 'Orchard Lane Dental',
  'Bluecairn Logistics', 'Fernway Clinics', 'Silverbirch Legal', 'Juniper Grid', 'Larkhill Security', 'Wavecrest Travel', 'Ember & Oak',
  'Rookery Data', 'Quillstone HR', 'Meadowlark Energy', 'Tallgrass Insurance', 'Foxglove Retail', 'Granite Peak Capital', 'Nimbus Kitchen',
  'Parallax Learning', 'Redfern Foods', 'Sablewood Interiors', 'Thornbury Labs', 'Umbra Cloud', 'Westerly Marine',
];

export const TITLES = [
  'Founder & CEO', 'Co-founder', 'Head of Growth', 'VP Sales', 'VP Marketing', 'Chief Revenue Officer', 'Head of Partnerships', 'Marketing Director',
  'Sales Director', 'Head of Demand Generation', 'Growth Lead', 'Director of Business Development', 'COO', 'Head of Operations',
  'Practice Owner', 'Managing Partner', 'Agency Owner', 'Head of RevOps', 'Customer Success Lead', 'Product Marketing Manager',
];

export const LOCATIONS = [
  'Austin, Texas', 'Denver, Colorado', 'Toronto, Ontario', 'London, England', 'Manchester, England', 'Dublin, Ireland', 'Berlin, Germany',
  'Amsterdam, Netherlands', 'Lisbon, Portugal', 'Barcelona, Spain', 'Stockholm, Sweden', 'Chicago, Illinois', 'Seattle, Washington',
  'Boston, Massachusetts', 'Sydney, Australia', 'Singapore', 'Bengaluru, India', 'Cape Town, South Africa', 'Vancouver, British Columbia', 'Paris, France',
];

export const SCHOOLS = ['Riverside University', 'Northgate Business School', 'Lakeshore Institute of Technology', 'Westbrook College', 'Hillcrest University', 'Eastvale Polytechnic'];

export const SKILLS = ['Go-to-market strategy', 'B2B sales', 'Demand generation', 'Partnerships', 'SaaS', 'Team leadership', 'Pipeline management', 'Content marketing', 'Customer success', 'Revenue operations', 'Product marketing', 'Negotiation'];

export const POST_TOPICS = [
  'why we stopped gating our pricing page', 'what 18 months of outbound taught our team', 'hiring our first sales rep', 'a playbook for partner-led growth',
  'how we cut our onboarding time in half', 'the metrics our board actually reads', 'lessons from our first conference booth', 'building a referral loop that works',
  'why our best leads came from webinars', 'moving from founder-led sales to a team',
];

export const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
