// Health page guides ("Look closer"), transcribed from health-page-PRD.md section 6.
// Supabase URLs keep the literal {ref} / {org} placeholders; another module fills them in at runtime.

export type GuideLinkKind = 'supabase' | 'app' | 'provider';
export interface GuideLink { label: string; url: string; kind: GuideLinkKind }
export interface GuideRow { see: string; means: string; do: string; next?: string }
export interface Guide {
  key: string;
  title: string;
  checkedOn: string;
  intro?: string;
  links: GuideLink[];
  steps: string[];
  read: GuideRow[];
  after?: string;
}

export const SUPABASE_LINKS: Record<string, { label: string; path: string }> = {
  observability: { label: 'Observability (reports)', path: 'https://supabase.com/dashboard/project/{ref}/observability' },
  apiOverview: { label: 'API overview report', path: 'https://supabase.com/dashboard/project/{ref}/observability/api-overview' },
  logs: { label: 'Logs', path: 'https://supabase.com/dashboard/project/{ref}/logs' },
  explorer: { label: 'Explorer (run SQL on the database or the logs)', path: 'https://supabase.com/dashboard/project/{ref}/explorer' },
  queryPerformance: { label: 'Query Performance', path: 'https://supabase.com/dashboard/project/{ref}/database/query-performance' },
  performanceAdvisor: { label: 'Performance Advisor', path: 'https://supabase.com/dashboard/project/{ref}/advisors/performance' },
  securityAdvisor: { label: 'Security Advisor', path: 'https://supabase.com/dashboard/project/{ref}/advisors/security' },
  healthAdvisor: { label: 'Health Advisor', path: 'https://supabase.com/dashboard/project/{ref}/advisors/health' },
  functions: { label: 'Edge Functions', path: 'https://supabase.com/dashboard/project/{ref}/functions' },
  integrations: { label: 'Integrations (Cron and Queues are inside)', path: 'https://supabase.com/dashboard/project/{ref}/integrations' },
  infrastructure: { label: 'Infrastructure (compute size)', path: 'https://supabase.com/dashboard/project/{ref}/settings/infrastructure' },
  usage: { label: 'Usage (organisation)', path: 'https://supabase.com/dashboard/org/{org}/usage' },
};

const sb = (id: string, label?: string): GuideLink => ({
  label: label ?? SUPABASE_LINKS[id].label,
  url: SUPABASE_LINKS[id].path,
  kind: 'supabase',
});
const app = (label: string, url: string): GuideLink => ({ label, url, kind: 'app' });
const pv = (label: string, url: string): GuideLink => ({ label, url, kind: 'provider' });

const L = {
  observability: sb('observability'),
  apiOverview: sb('apiOverview'),
  logs: sb('logs'),
  explorer: sb('explorer'),
  queryPerformance: sb('queryPerformance'),
  performanceAdvisor: sb('performanceAdvisor'),
  securityAdvisor: sb('securityAdvisor'),
  healthAdvisor: sb('healthAdvisor'),
  functions: sb('functions'),
  integrations: sb('integrations'),
  cron: sb('integrations', 'Integrations → Cron'),
  queues: sb('integrations', 'Integrations → Queues'),
  infrastructure: sb('infrastructure'),
  usage: sb('usage'),
  supabaseStatus: pv('Supabase status', 'https://status.supabase.com'),
  unipile: pv('Unipile dashboard', 'https://dashboard.unipile.com'),
  aiStatus: pv('AI provider status', 'https://status.claude.com'),
  aiConsole: pv('AI provider console', 'https://platform.claude.com'),
  geminiConsole: pv('AI provider console (Gemini)', 'https://aistudio.google.com'),
  resendStatus: pv('Resend status', 'https://resend-status.com'),
  stripeStatus: pv('Stripe status', 'https://status.stripe.com'),
  elevenStatus: pv('ElevenLabs status', 'https://status.elevenlabs.io'),
  elevenDashboard: pv('ElevenLabs dashboard', 'https://elevenlabs.io/app'),
  failedSends: app('Failed sends (app)', '/outreach/inbox/sent?segment=failed'),
  adminTool: app('A workspace in the admin tool (app)', '/outreach/settings/admin'),
  needsYou: app('AI → Needs you (app)', '/outreach/ai/needs-you'),
};

const CHECKED = '2026-10-07';
const r = (see: string, means: string, doIt: string, next?: string): GuideRow =>
  next ? { see, means, do: doIt, next } : { see, means, do: doIt };

export const GUIDES: Record<string, Guide> = {
  G1: {
    key: 'G1',
    title: 'The database is working too hard',
    checkedOn: CHECKED,
    links: [L.observability, L.infrastructure],
    steps: [
      'Open Observability and choose the **Database** report. Set the range to the last 24 hours.',
      'Look at three charts: **CPU usage**, **Memory usage**, **Disk IOPS**. On Disk IOPS, the straight line is the most your compute size can do.',
      'Note the times of the peaks, then compare with the table.',
    ],
    read: [
      r('CPU jumps at the same minute every hour or day, then drops', 'A scheduled job is heavy', 'Match the time in G7. Not a reason to upgrade', 'G7'),
      r('CPU high and flat for hours', 'A query that runs all the time is slow', 'G3. Fix this before thinking about an upgrade', 'G3'),
      r('The "IOWait" part of CPU is large', 'The database is waiting for the disk', 'Look at Disk IOPS, next row'),
      r('Disk IOPS touching the line', 'The disk is the bottleneck. Most often a query reading a whole large table', 'G3. If G3 is clean, go up one compute size', 'G3'),
      r('Memory high and swap being used', 'Not enough memory. Supabase: sustained swap means memory pressure and slows the database a lot', 'If G3 shows nothing heavy, go up one compute size', 'G3'),
      r('All three high, G3 clean, and customers have grown', 'Real growth', 'Upgrade (G15)', 'G15'),
    ],
  },
  G2: {
    key: 'G2',
    title: 'Too many connections',
    checkedOn: CHECKED,
    links: [L.observability],
    steps: [
      'Read the table in the card: who is connected, in what state, how many.',
      'Open Observability, **Database** report, **Database connections** chart, last 24 hours. Check **Dedicated Pooler connections** and **Shared Pooler connections** too.',
    ],
    read: [
      r('Many connections in the state `idle in transaction`', 'Code opens a transaction and doesn\'t close it', 'A bug. Copy the prompt'),
      r('The count jumps every few seconds and falls again', 'Scheduled jobs. Each running job holds one connection', 'G7. Spread the jobs out or slow the idle ones', 'G7'),
      r('A steady climb as more people use the app', 'Normal growth', 'Watch it. Act at 80%'),
      r('Edge Functions holding many direct connections', 'Functions are connecting straight to Postgres', 'Ask Claude to move them to the pooler or to the Supabase client'),
      r('Near the limit all day, none of the above', 'The compute size is too small for the traffic', 'Go up one size. The limit per size is on the Usage tab'),
    ],
  },
  G3: {
    key: 'G3',
    title: 'Slow queries',
    checkedOn: CHECKED,
    links: [L.queryPerformance, L.performanceAdvisor],
    steps: [
      'Look at the first row in the card. It is the query using the most database time in the last hour.',
      'Open Query Performance and order the list by total time. Find the same query.',
      'Open the Performance Advisor. See whether it names the same table.',
    ],
    read: [
      r('One query with a large share of the time and an average over 100 ms', 'Usually a missing index. The Advisor often names it ("unindexed foreign keys")', 'Copy the prompt. Ask for the index as a migration'),
      r('A query that takes a few milliseconds but runs a huge number of times', 'The code calls it in a loop, or polls too often', 'Reduce the calls. An index won\'t help'),
      r('A query that got slower this week with the same number of calls', 'Its table grew', 'G4, then an index or a clean-up', 'G4'),
      r('The top queries come from the scheduled jobs or from Health itself', 'Our own background work', 'Lower how often it runs'),
      r('The Advisor lists "unused index"', 'Harmless', 'Ignore unless disk is tight'),
    ],
    after: 'After a fix, check the card again in an hour. It compares one hour with the hour before.',
  },
  G4: {
    key: 'G4',
    title: 'Database size and growing tables',
    checkedOn: CHECKED,
    links: [L.observability, L.usage, L.infrastructure],
    steps: [
      'Read the table in the card: the 20 biggest tables, their size, and how much each grew in 7 days.',
      'Open Observability, **Database** report, and compare **Database size** with **Disk usage**.',
    ],
    read: [
      r('The biggest table is a log: `cron.job_run_details`, `ops.inbound_events`, `ops.*`, `audit_log`, `ai_calls`, a queue\'s archive', 'A clean-up job is missing or not running', 'Check in G7 that `cleanup` ran. Shorten how long the rows are kept', 'G7'),
      r('`messages` or `leads` is biggest and grows with customers', 'Real growth', 'Fine. Watch "full within" on the card'),
      r('The size jumped in one day', 'An import, or code writing rows in a loop', 'The card shows which table. Copy the prompt'),
      r('Disk usage is much larger than database size', 'Space held by deleted rows, or by the database\'s own write log', 'Ask Claude to run a bloat check'),
    ],
  },
  G5: {
    key: 'G5',
    title: 'Stuck or blocked queries',
    checkedOn: CHECKED,
    links: [L.explorer],
    steps: [
      'Read the list in the card: who, state, how long, waiting on what, blocked by whom, first 200 characters of the query.',
      'To see it live, open Explorer, choose **Run SQL** with the database as the source, and run the query shown under the list.',
    ],
    read: [
      r('`idle in transaction` for minutes', 'Code started a change and never finished it. Others queue behind it', 'A bug. Copy the prompt. Ask Claude before ending the query by hand'),
      r('An active query running for minutes, from a scheduled job', 'A heavy job', 'G7', 'G7'),
      r('A row with a number under "blocked by"', 'That number is the query causing the wait', 'Find its row and read what it\'s doing'),
      r('It happens only during a deploy', 'A migration is changing a table', 'Expected. It clears when the migration ends'),
    ],
  },
  G6: {
    key: 'G6',
    title: 'Supabase advisor findings',
    checkedOn: CHECKED,
    links: [L.securityAdvisor, L.performanceAdvisor, L.healthAdvisor],
    steps: [
      'Open the Security Advisor first. Each finding has a level and a link to how to fix it.',
      'Then the Performance Advisor.',
    ],
    read: [
      r('A security finding at ERROR, e.g. a table without row-level security, or exposed auth users', 'Customer data may be readable by people who shouldn\'t see it', 'Fix today. Copy the prompt'),
      r('A performance finding at WARN, e.g. unindexed foreign keys', 'A query will slow down as the table grows', 'Fix this week if the table is large'),
      r('A finding at INFO', 'A suggestion', 'Ignore'),
      r('A finding about something done on purpose', 'Supabase says to check findings against what you intended', 'Snooze the check with the reason'),
    ],
  },
  G7: {
    key: 'G7',
    title: 'Scheduled jobs',
    checkedOn: CHECKED,
    intro: 'A scheduled job has two halves. The database starts it on time and asks a function to do the work. The cron history only covers the first half: "succeeded" there means the request was sent. Whether the work finished is in G8.',
    links: [L.cron, L.functions],
    steps: [
      'Read the table in the card: job, schedule, last start, result, how long, how late.',
      'Open Integrations, then **Cron**, and open the job\'s history.',
    ],
    read: [
      r('Every job late or not running', 'The scheduler has stopped, or the database is overloaded', 'G1 first. If the database is calm, Supabase\'s fix is a fast reboot from project settings', 'G1'),
      r('One job failed with an error message', 'The SQL the job runs has a problem', 'Copy the prompt with the message'),
      r('Jobs start on time but the function shows no runs', 'The call from the database to the function is failing: wrong address or cron secret, or Edge Functions are down', 'G8, then Supabase status', 'G8'),
      r('More than 8 jobs running at once', 'Too many overlap. pg_cron allows 32 at once and each uses a database connection', 'Stagger the schedules. Slow the idle polling'),
      r('A job runs longer than the gap between its runs', 'Runs overlap and pile up', 'Ask Claude to add "skip if the last run is still going"'),
    ],
  },
  G8: {
    key: 'G8',
    title: 'A function is failing, slow or being stopped',
    checkedOn: CHECKED,
    links: [L.functions, L.logs],
    steps: [
      'Read the card: which function, how many failures, the most common error text, the time of one example.',
      'Open Edge Functions and click the function. On **Invocations**, filter by status code around that time.',
      'Open **Logs** on the same function at the same time to read the error.',
    ],
    read: [
      r('500', 'The code threw an error', 'Copy the prompt with the error text'),
      r('503', 'The function couldn\'t start: a broken deploy or a missing secret', 'Redeploy the last working version, then fix'),
      r('504', 'No answer in time. It is waiting on a slow outside service or a slow query', 'G12 or G3. Do less in each run', 'G12'),
      r('546', 'Supabase stopped it for using too much memory or processing time (256 MB, 2 s of CPU per request)', 'Process fewer items per run. Move heavy work into the database'),
      r('401', 'The caller\'s key or secret is wrong', 'Check the cron secret'),
      r('Health says runs didn\'t finish, and there is no error in our own records', 'Almost always a 546 or 504', 'Confirm on Invocations'),
      r('It succeeds but is near the time limit', 'Each run takes on too much', 'Lower the batch size'),
    ],
  },
  G9: {
    key: 'G9',
    title: 'Messages not coming in',
    checkedOn: CHECKED,
    links: [L.queues, L.unipile],
    steps: [
      'Read the card: how many events are waiting, the age of the oldest, when the last one arrived.',
    ],
    read: [
      r('Events arrive but the waiting pile grows', '`process-inbound` is failing or too slow', 'G8', 'G8'),
      r('Nothing arrives, and senders are connected', 'Unipile isn\'t calling us: the webhook was removed, the address changed after a deploy, or the secret doesn\'t match', 'Check webhooks in the Unipile dashboard. Run `bootstrap-webhooks.ts` again'),
      r('The same rows show an error and a rising attempt count', 'One bad event is being retried forever', 'Copy the prompt with the event id'),
      r('A queue\'s length is steady but its oldest message keeps getting older', 'The job that empties it isn\'t running', 'G7', 'G7'),
      r('Only "new connection" events are late', 'Normal. Unipile reports these up to 8 hours late', 'Nothing'),
      r('It\'s night for most senders', 'A quiet period', 'Nothing. This check never goes red on its own before 6 hours'),
    ],
  },
  G10: {
    key: 'G10',
    title: 'Sends failing or late',
    checkedOn: CHECKED,
    links: [L.failedSends, L.unipile],
    steps: [
      'Read the card: failures grouped by error code, by sender and by workspace.',
      'Open Failed sends to see the same items a customer sees.',
    ],
    read: [
      r('`422 cannot_resend_yet`', 'LinkedIn\'s weekly invite cap for that sender', 'Nothing. The system stops invites until Monday'),
      r('`429` on a few senders', 'LinkedIn is being asked too fast on those accounts', 'The system pauses them. If it repeats, lower their daily limits'),
      r('`429` or `500` across many senders', 'A problem at Unipile or LinkedIn', 'G12. Don\'t retry by hand', 'G12'),
      r('Failures in one workspace only', 'That customer\'s content or leads', 'Open the workspace and contact them'),
      r('Sends late, none failing', '`worker-tick` isn\'t running, or the plan is empty', 'G7, then `job-5`', 'G7'),
      r('Tomorrow\'s plan is incomplete', '`worker-planner` failed for some senders', 'G8 for `worker-planner`', 'G8'),
    ],
  },
  G11: {
    key: 'G11',
    title: 'Senders disconnected',
    checkedOn: CHECKED,
    links: [L.adminTool, L.unipile],
    steps: [
      'Read the card: how many senders disconnected, when, and which ones.',
    ],
    read: [
      r('A few, spread over days', 'Normal. LinkedIn asks people to log in again', 'The reconnect email already goes out. Nothing'),
      r('Many within an hour', 'An incident at Unipile or LinkedIn', 'Pause sending. Don\'t retry in a loop: Unipile says a pile of rejected requests is itself a cause of disconnects'),
      r('The same sender again and again', 'Their proxy country, or they use LinkedIn somewhere that conflicts', 'Contact the user'),
      r('Disconnected over 24 hours, never reconnected', 'The person hasn\'t seen the email', 'Message them. They also show under Stuck users'),
    ],
  },
  G12: {
    key: 'G12',
    title: 'An outside service is failing or slow',
    checkedOn: CHECKED,
    links: [L.unipile, L.aiStatus, L.aiConsole, L.geminiConsole, L.resendStatus, L.stripeStatus, L.elevenStatus],
    steps: [
      'Read the card: provider, which call, which status codes, since when.',
      'Open the provider\'s status page.',
    ],
    read: [
      r('401 or 403', 'The key is wrong, revoked or expired', 'Create a new key at the provider and replace it in Vault'),
      r('402, or "insufficient credit" or "quota"', 'Credit or the plan\'s allowance has run out', 'Top up or raise the plan at the provider'),
      r('429', 'We are calling too fast', 'The system slows down by itself. If it stays, ask the provider for a higher limit'),
      r('500s or timeouts on many calls', 'The provider has a problem', 'Their status page. The system retries. Nothing to fix'),
      r('500s on one call only, starting at a deploy', 'Our request is wrong', 'Copy the prompt'),
      r('Everything works but slowly', 'The provider is degraded', 'Nothing unless it lasts a day'),
    ],
  },
  G13: {
    key: 'G13',
    title: 'Errors people see in the app',
    checkedOn: CHECKED,
    links: [L.apiOverview, L.logs],
    steps: [
      'Read the card: error text, screen, people affected, first seen, last seen, app version.',
      'Open Logs and filter by status to the 500s around the same time. Supabase\'s Logs view shows one request across the API gateway, the database and functions.',
    ],
    read: [
      r('First seen minutes after a deploy', 'That deploy', 'Roll back, or copy the prompt and fix forward'),
      r('One person only', 'Their data or their browser', 'Open their workspace'),
      r('Many people, one screen', 'A bug on that screen', 'Copy the prompt'),
      r('500s that mention a timeout', 'The database is slow', 'G1 and G3', 'G1'),
      r('A jump in 401s or 403s', 'Sessions, or a change to row-level security', 'Look at the last migration'),
    ],
  },
  G14: {
    key: 'G14',
    title: 'Stuck users',
    checkedOn: CHECKED,
    links: [],
    steps: ['Open the Stuck users tab.'],
    read: [],
  },
  G15: {
    key: 'G15',
    title: 'Usage, the bill and upgrading',
    checkedOn: CHECKED,
    links: [L.usage, L.infrastructure],
    steps: [
      'Open Usage. Choose the current billing period.',
      'Read **Egress**, **Realtime peak connections** and **Realtime messages**. Health can\'t read these three by itself.',
      'Type the three numbers into the Usage tab. Health keeps them and shows the trend.',
    ],
    read: [
      r('Egress climbing faster than customers', 'Large responses: lists without paging, or big files', 'Ask Claude which requests return the most data'),
      r('Function invocations heading over the included amount', 'Idle polling. The 10- and 15-second jobs make up most of it', 'It costs $2 per extra million. Slow the idle jobs if it matters'),
      r('Realtime connections near the limit', 'Many tabs open at once', '$10 per extra 1,000. Not a fault'),
      r('Disk past what\'s included', 'Growth', '$0.125 per extra GB on Pro. G4 if a log table is the cause', 'G4'),
    ],
    after: 'Upgrade rules are in §7.3.',
  },
  G16: {
    key: 'G16',
    title: 'The checks have stopped',
    checkedOn: CHECKED,
    links: [L.cron, L.functions, L.supabaseStatus],
    steps: [
      'Compare what you see with the table.',
    ],
    read: [
      r('`health-run` hasn\'t started', 'The scheduler stopped', 'G7, first row', 'G7'),
      r('`health-run` fails', 'A check\'s SQL has an error', 'Copy the prompt with the message'),
      r('Only the Supabase-sourced checks are grey', 'The metrics endpoint or Management API token stopped working', 'Replace the token in Vault'),
      r('No daily email arrived', '`health-daily` or Resend', 'G8 for `health-daily`, then G12 for Resend', 'G8'),
      r('"Everything is being measured" names a function', 'That function isn\'t wrapped, so its failures don\'t show anywhere on this page', 'Copy the prompt'),
      r('The two counts of AI calls differ', 'Some AI call skips the helper or the wrapper', 'Run the build check. Copy the prompt with the purpose it names'),
      r('AI calls with no outcome', 'Code that logs to `ai_calls` without going through the helper', 'Copy the prompt'),
    ],
  },
  G17: {
    key: 'G17',
    title: 'The AI provider is failing, or its answers can\'t be used',
    checkedOn: CHECKED,
    links: [L.aiStatus, L.aiConsole, L.geminiConsole, L.adminTool, L.functions],
    steps: [
      'Read the card: which purpose (reply draft, classifying, personalized lines, fields, website assistant), which status code or outcome, which model, which workspaces, since when.',
      'Open the provider\'s status page.',
      'If the status page is clean, see whether the trouble sits in one purpose, one workspace or one model. The table reads each case.',
    ],
    read: [
      r('500s or "overloaded" on every purpose, and the status page shows an incident', 'The provider is down', 'Nothing to fix. AI replies in that window ended as `failed` and were left for a person; lines used their fallback. The card lists how many, by workspace. When it recovers, decide whether to run the replies again: one that is hours late is often better written by a person'),
      r('429 on the platform key', 'We are past the provider\'s limit for requests or tokens a minute', 'Open the provider console\'s limits page and ask for a higher tier. Writing lines in bulk competes with live replies, so ask Claude to slow the bulk work first'),
      r('401, 402 or 403 on the platform key', 'The key was revoked, or credit ran out', 'Provider console, billing. Replace the key in Vault. This one emails you at once'),
      r('401 on one customer\'s own key only', 'Their key', 'Nothing for the platform. They see the "key invalid" message and appear in §7.2'),
      r('Timeouts, and the status page is clean', 'Our requests are too large or too slow: long threads, a high length limit, a high thinking setting', 'Copy the prompt. If the function is also being stopped, G8', 'G8'),
      r('`cut_off` on one purpose', 'The answer is longer than that purpose\'s length limit allows', 'Raise the limit for that purpose, or ask the AI for less'),
      r('`bad_format` on one purpose, starting at a deploy or a model change', 'The prompt, the expected shape or the model id changed', 'Copy the prompt with two example call ids'),
      r('`bad_format` spread thinly across purposes, under the watch line', 'Normal. The retry handles it', 'Nothing'),
      r('`empty` or `refused` in one workspace', 'That customer\'s prompt or content trips the model\'s safety rules', 'Open their AI setup in the admin tool. Contact them'),
      r('`refused` or `bad_format` across workspaces on one model only', 'The model changed behaviour', 'Switch that purpose to another model. Model ids are settings, not code'),
    ],
  },
  G18: {
    key: 'G18',
    title: 'AI work waiting, or the AI giving up',
    checkedOn: CHECKED,
    links: [L.adminTool, L.needsYou, L.functions],
    steps: [
      'Read the card: which feature, how many items are waiting and the age of the oldest, or the giving-up share against its 7-day average. The card splits it by workspace, sequence, reason and prompt version.',
      'Check G17 first. If the provider is failing, that is the cause and this card clears when it does.',
    ],
    read: [
      r('Replies stuck in drafting, provider fine', '`ai-reply-worker` isn\'t running or is failing', 'G7, then G8', 'G7'),
      r('Lines waiting in every workspace', '`outreach-ai-variables` isn\'t running, is failing, or is being rate-limited', 'G8, then G17', 'G8'),
      r('Lines waiting in one workspace', 'Their AI allowance is used up, their key is rejected, or the variable was switched off', '§7.2. Contact them'),
      r('Website visitors waiting', 'A live visitor is looking at a silent chat', 'G17 first, then G8 for `outreach-webchat`', 'G17'),
      r('Giving up rose in one workspace, from the hour their prompt version changed', 'Their new prompt escalates more, or contradicts itself', 'Read the reasons on the card. Tell the customer what changed'),
      r('Giving up rose in every workspace from the same hour', 'Our deploy, a model change at the provider, or a check that became too strict', 'Copy the prompt with the hour and the top reasons'),
      r('Failed rose, escalated stayed flat', 'The provider, not the prompts', 'G17', 'G17'),
      r('The website assistant is stumped more, in one workspace', 'Their knowledge is missing the answers', 'Theirs to fix, in AI → Knowledge. The open questions are listed there'),
      r('More handovers for meetings and bookings', 'Good news', 'Nothing. These aren\'t counted'),
    ],
  },
  G19: {
    key: 'G19',
    title: 'Voice calls failing',
    checkedOn: CHECKED,
    links: [L.elevenStatus, L.elevenDashboard, L.functions],
    steps: [
      'Read the card: failed calls by workspace and by end reason, calls still open, agents with a sync error, how long `outreach-voice-tools` took.',
      'Open the ElevenLabs status page.',
    ],
    read: [
      r('Calls failing in every workspace, and an incident on the status page', 'ElevenLabs is down', 'Nothing. Visitors are moved to text chat by themselves'),
      r('Starts refused for one workspace', 'Their voice minutes are used up', '§7.2'),
      r('Starts refused as "busy" across workspaces', 'The platform-wide limit on calls at once was reached', 'Raise `voice_platform_concurrency`, and the ElevenLabs plan if it is the cap'),
      r('Calls still open 30 min after they started', 'The post-call record never arrived, and the 5-minute fallback fetch is failing too', 'G8 for `outreach-elevenlabs-webhook` and `outreach-webchat-worker`. Run `scripts/outreach-elevenlabs-setup.mjs` again', 'G8'),
      r('`outreach-voice-tools` taking seconds', 'The agent gives up waiting after 8 seconds and tells the visitor it found nothing', 'G3. The knowledge search is slow', 'G3'),
      r('An agent with a sync error', 'Settings didn\'t reach ElevenLabs. The live agent keeps its last good settings', 'Read the error. On a customer\'s own key, it is their key'),
      r('Errors on one website only', 'That site or its visitors: microphone blocked, or the page blocks the connection', 'Contact the customer'),
      r('The call worked but sounded wrong', 'Health can\'t see inside a call', 'Open the call in the ElevenLabs dashboard by its conversation id, shown on the card'),
    ],
  },
};

export function guideFor(key: string): Guide | null {
  return GUIDES[key] ?? null;
}
