# Kande VendTech — Outreach Integration Guide
## Apollo.io → Instantly.ai Cold Email Pipeline

> **Sending account:** kurtis@kandevendtech.co  
> **Status:** Warmup enabled (started Feb 2, 2025)  
> **Target:** Ready for live campaigns ~Feb 16-23 (after 2-3 weeks warmup)

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Instantly.ai API v2 Reference](#instantlyai-api-v2-reference)
3. [Apollo.io API Reference](#apolloio-api-reference)
4. [Apollo → Instantly Sync Workflow](#apollo--instantly-sync-workflow)
5. [Warmup Monitoring](#warmup-monitoring)
6. [Rate Limits & Best Practices](#rate-limits--best-practices)
7. [Dashboard Integration Notes](#dashboard-integration-notes)

---

## 1. Architecture Overview

```
┌──────────────┐     Search/Enrich      ┌──────────────┐
│  Apollo.io   │ ◄──────────────────►  │  Dashboard    │
│  (Lead DB)   │    API v1              │  /outreach    │
└──────┬───────┘                        └──────┬───────┘
       │                                        │
       │  Enriched leads                        │  Monitor/Control
       │  (name, email, title,                  │
       │   company, domain)                     │
       ▼                                        ▼
┌──────────────┐     Create campaigns   ┌──────────────┐
│  Sync Layer  │ ──────────────────►   │ Instantly.ai  │
│  (Dashboard  │     Add leads          │  (Sending)    │
│   API routes)│     Check warmup       │               │
└──────────────┘                        └──────────────┘
```

**Environment Variables (Railway):**
- `INSTANTLY_API_KEY` — Bearer token for Instantly API v2
- `APOLLO_API_KEY` — API key for Apollo REST API

---

## 2. Instantly.ai API v2 Reference

**Base URL:** `https://api.instantly.ai`  
**Auth:** Bearer token → `Authorization: Bearer {INSTANTLY_API_KEY}`  
**Docs:** https://developer.instantly.ai/api/v2

### Key Endpoints

#### Campaigns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/campaigns` | Create a new campaign |
| `GET` | `/api/v2/campaigns` | List campaigns (paginated) |
| `GET` | `/api/v2/campaigns/{id}` | Get single campaign |
| `PATCH` | `/api/v2/campaigns/{id}` | Update campaign |
| `POST` | `/api/v2/campaigns/{id}/activate` | Activate campaign |
| `POST` | `/api/v2/campaigns/{id}/pause` | Pause campaign |

**Create Campaign — Full Example:**
```json
POST /api/v2/campaigns
{
  "name": "Apartments - Las Vegas Q1 2025",
  "campaign_schedule": {
    "start_date": "2025-02-17",
    "schedules": [{
      "name": "Business Hours",
      "timing": { "from": "08:00", "to": "17:00" },
      "days": {
        "0": false, "1": true, "2": true, "3": true,
        "4": true, "5": true, "6": false
      },
      "timezone": "America/Los_Angeles"
    }]
  },
  "sequences": [{
    "steps": [
      {
        "type": "email",
        "wait_days": 0,
        "variants": [{
          "subject": "Quick question about {{company_name}}",
          "body": "<p>Hi {{first_name}},</p><p>I noticed {{company_name}} manages several properties in the area...</p>"
        }]
      },
      {
        "type": "email",
        "wait_days": 3,
        "variants": [{
          "subject": "Re: Quick question about {{company_name}}",
          "body": "<p>{{first_name}}, just circling back on my last note...</p>"
        }]
      }
    ]
  }],
  "email_list": ["kurtis@kandevendtech.co"],
  "daily_limit": 25,
  "daily_max_leads": 25,
  "stop_on_reply": true,
  "stop_on_auto_reply": false,
  "text_only": true,
  "first_email_text_only": true,
  "open_tracking": false,
  "link_tracking": false,
  "email_gap": 15,
  "random_wait_max": 10,
  "stop_for_company": true,
  "insert_unsubscribe_header": true
}
```

> **⚠️ CRITICAL SETTINGS for a new domain:**
> - `text_only: true` — No HTML = better deliverability during early sending
> - `open_tracking: false` — Tracking pixels hurt deliverability on fresh domains
> - `link_tracking: false` — Tracked links use redirects that spam filters flag
> - `daily_limit: 25` — Start LOW. Scale to 50 after week 1, then 75-100 over time
> - `stop_for_company: true` — One reply from a domain stops the whole company
> - `insert_unsubscribe_header: true` — Required for CAN-SPAM compliance

#### Leads

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/leads` | Create a single lead |
| `POST` | `/api/v2/leads/batch` | Batch create leads (up to 1000) |
| `GET` | `/api/v2/leads` | List leads (filter by campaign, status) |
| `GET` | `/api/v2/leads/{id}` | Get single lead |
| `PATCH` | `/api/v2/leads/{id}` | Update lead |
| `DELETE` | `/api/v2/leads/{id}` | Delete lead |

**Create Lead Example:**
```json
POST /api/v2/leads
{
  "email": "jsmith@sunriseapts.com",
  "first_name": "John",
  "last_name": "Smith",
  "company_name": "Sunrise Apartments",
  "company_domain": "sunriseapts.com",
  "phone": "+17025551234",
  "website": "https://sunriseapts.com",
  "campaign": "CAMPAIGN_UUID_HERE",
  "skip_if_in_workspace": true,
  "skip_if_in_campaign": true,
  "verify_leads_on_import": true,
  "custom_variables": {
    "property_type": "apartment",
    "unit_count": "200",
    "city": "Las Vegas",
    "source": "apollo"
  }
}
```

**Lead Status Codes:**
| Code | Meaning |
|------|---------|
| `1` | Active |
| `2` | Paused |
| `3` | Completed |
| `-1` | Bounced |
| `-2` | Unsubscribed |
| `-3` | Skipped |

**Interest Status Codes:**
| Code | Meaning |
|------|---------|
| `1` | Interested |
| `2` | Meeting Booked |
| `3` | Meeting Completed |
| `4` | Won |
| `-1` | Not Interested |
| `-2` | Wrong Person |
| `-3` | Lost |

#### Lead Lists

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/lead-lists` | Create a list |
| `GET` | `/api/v2/lead-lists` | List all lead lists |
| `GET` | `/api/v2/lead-lists/{id}` | Get a lead list |

#### Email Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v2/accounts` | List email accounts |
| `GET` | `/api/v2/accounts/{email}` | Get specific account |
| `PATCH` | `/api/v2/accounts/{email}` | Update account settings |

#### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/accounts/warmup-analytics` | Warmup health data |
| `GET` | `/api/v2/accounts/analytics/daily` | Daily sending analytics |
| `POST` | `/api/v2/accounts/test/vitals` | Test account health |
| `GET` | `/api/v2/campaigns/analytics` | Campaign performance stats |

#### Email Verification

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/email-verification` | Verify a single email |

#### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v2/webhooks` | Create webhook subscription |
| `GET` | `/api/v2/webhooks` | List webhooks |

---

## 3. Apollo.io API Reference

**Base URL:** `https://api.apollo.io`  
**Auth:** API Key in request body or header → `x-api-key: {APOLLO_API_KEY}`  
**Docs:** https://docs.apollo.io/reference

### Key Endpoints for Kande VendTech

#### People Search (FREE — no credits)

```
POST https://api.apollo.io/api/v1/mixed_people/api_search
```

Search the Apollo database for net new prospects. **Does NOT consume credits** and **does NOT return emails/phones** — use enrichment after.

**Key Parameters:**
```json
{
  "api_key": "APOLLO_API_KEY",
  "page": 1,
  "per_page": 100,
  "person_titles": ["Property Manager", "Facilities Manager", "Director of Operations"],
  "person_locations": ["Las Vegas, Nevada"],
  "organization_industry_tag_ids": ["real estate", "healthcare"],
  "organization_num_employees_ranges": ["11,50", "51,200", "201,1000"],
  "person_seniorities": ["manager", "director", "vp", "c_suite"]
}
```

**Important:** Returns up to 50,000 records (100/page, 500 pages max). Use filters aggressively.

#### People Enrichment (COSTS CREDITS)

```
POST https://api.apollo.io/api/v1/people/match
```

Enrich a single person — returns email, phone, full profile.

```json
{
  "api_key": "APOLLO_API_KEY",
  "first_name": "John",
  "last_name": "Smith",
  "organization_name": "Sunrise Apartments",
  "domain": "sunriseapts.com",
  "reveal_personal_emails": false,
  "reveal_phone_number": true
}
```

#### Bulk People Enrichment (COSTS CREDITS — up to 10 at once)

```
POST https://api.apollo.io/api/v1/people/bulk_match
```

```json
{
  "api_key": "APOLLO_API_KEY",
  "reveal_personal_emails": false,
  "reveal_phone_number": true,
  "details": [
    {
      "first_name": "John",
      "last_name": "Smith",
      "domain": "sunriseapts.com"
    },
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "domain": "vegashealthcare.com"
    }
  ]
}
```

> **Rate limit:** Bulk enrichment is throttled to 50% of the per-minute rate for single enrichment. Batch 10 at a time, wait 2 seconds between batches.

#### Organization Search (COSTS CREDITS)

```
POST https://api.apollo.io/api/v1/mixed_companies/search
```

Search companies by industry, size, location.

```json
{
  "api_key": "APOLLO_API_KEY",
  "page": 1,
  "per_page": 100,
  "organization_locations": ["Las Vegas, Nevada"],
  "organization_industry_tag_ids": ["property management"],
  "organization_num_employees_ranges": ["11,50", "51,200"]
}
```

#### Contacts (CRM — your saved contacts)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/contacts/search` | Search your saved contacts |
| `POST` | `/api/v1/contacts` | Create a contact |
| `PATCH` | `/api/v1/contacts/{id}` | Update a contact |
| `GET` | `/api/v1/contacts/{id}` | View contact |
| `POST` | `/api/v1/contacts/bulk_create` | Bulk create contacts |

#### Sequences (Apollo's built-in email)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/emailer_campaigns/search` | List sequences |
| `POST` | `/api/v1/emailer_campaigns/{id}/add_contact_ids` | Add contacts to sequence |

> **We won't use Apollo sequences.** We use Instantly for sending. Apollo is our prospecting/enrichment engine only.

---

## 4. Apollo → Instantly Sync Workflow

### Step-by-Step Pipeline

```
1. SEARCH (Apollo - Free)
   ↓ Find people by title + location + industry
2. FILTER (Dashboard)
   ↓ Review, dedupe, score leads
3. ENRICH (Apollo - Credits)
   ↓ Get verified emails + phones
4. VERIFY (Instantly)
   ↓ Email verification before adding to campaign
5. ADD LEADS (Instantly)
   ↓ Create leads with campaign assignment
6. LAUNCH (Instantly)
   ↓ Activate campaign
7. MONITOR (Dashboard)
   ↓ Track warmup, opens, replies
```

### Sync Implementation (Dashboard API Route)

```typescript
// /api/outreach/sync-leads.ts

interface ApolloLead {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  organization: {
    name: string;
    website_url: string;
    industry: string;
    estimated_num_employees: number;
  };
  title: string;
  city: string;
  state: string;
  phone_numbers?: Array<{ raw_number: string }>;
}

interface InstantlyLead {
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  company_domain: string;
  phone: string | null;
  website: string | null;
  campaign: string;
  skip_if_in_workspace: boolean;
  skip_if_in_campaign: boolean;
  verify_leads_on_import: boolean;
  custom_variables: Record<string, string>;
}

// Step 1: Search Apollo for prospects
async function searchApolloProspects(params: {
  titles: string[];
  locations: string[];
  industries?: string[];
  employeeRanges?: string[];
  page?: number;
}): Promise<ApolloLead[]> {
  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.APOLLO_API_KEY,
      page: params.page || 1,
      per_page: 100,
      person_titles: params.titles,
      person_locations: params.locations,
      organization_industry_tag_ids: params.industries,
      organization_num_employees_ranges: params.employeeRanges,
      person_seniorities: ['manager', 'director', 'vp', 'owner'],
    }),
  });
  const data = await res.json();
  return data.people || [];
}

// Step 2: Enrich with emails (batch of 10)
async function enrichPeopleBatch(people: Array<{
  first_name: string;
  last_name: string;
  domain: string;
}>): Promise<any[]> {
  const res = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.APOLLO_API_KEY,
      reveal_personal_emails: false,
      reveal_phone_number: true,
      details: people,
    }),
  });
  const data = await res.json();
  return data.matches || [];
}

// Step 3: Transform Apollo leads → Instantly format
function transformToInstantlyLead(
  apolloLead: ApolloLead,
  campaignId: string,
  vertical: string
): InstantlyLead {
  const domain = apolloLead.organization?.website_url
    ?.replace(/https?:\/\//, '')
    ?.replace(/\/$/, '') || '';

  return {
    email: apolloLead.email,
    first_name: apolloLead.first_name,
    last_name: apolloLead.last_name,
    company_name: apolloLead.organization?.name || '',
    company_domain: domain,
    phone: apolloLead.phone_numbers?.[0]?.raw_number || null,
    website: apolloLead.organization?.website_url || null,
    campaign: campaignId,
    skip_if_in_workspace: true,
    skip_if_in_campaign: true,
    verify_leads_on_import: true,
    custom_variables: {
      title: apolloLead.title || '',
      industry: apolloLead.organization?.industry || '',
      employee_count: String(apolloLead.organization?.estimated_num_employees || ''),
      city: apolloLead.city || '',
      state: apolloLead.state || '',
      vertical: vertical,
      source: 'apollo',
      synced_at: new Date().toISOString(),
    },
  };
}

// Step 4: Push to Instantly (one at a time — safest for new accounts)
async function addLeadToInstantly(lead: InstantlyLead): Promise<any> {
  const res = await fetch('https://api.instantly.ai/api/v2/leads', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(lead),
  });
  return res.json();
}

// Main sync function
async function syncApolloToInstantly(config: {
  campaignId: string;
  vertical: string;
  titles: string[];
  locations: string[];
  industries?: string[];
  maxLeads?: number;
}) {
  const maxLeads = config.maxLeads || 50;
  let synced = 0;
  let page = 1;

  while (synced < maxLeads) {
    // 1. Search (free)
    const prospects = await searchApolloProspects({
      titles: config.titles,
      locations: config.locations,
      industries: config.industries,
      page,
    });

    if (prospects.length === 0) break;

    // 2. Enrich in batches of 10
    for (let i = 0; i < prospects.length && synced < maxLeads; i += 10) {
      const batch = prospects.slice(i, i + 10);
      const enrichmentDetails = batch.map(p => ({
        first_name: p.first_name,
        last_name: p.last_name,
        domain: p.organization?.website_url?.replace(/https?:\/\//, '').replace(/\/$/, '') || '',
      }));

      const enriched = await enrichPeopleBatch(enrichmentDetails);

      // 3. Transform and push to Instantly
      for (const person of enriched) {
        if (!person?.email) continue; // Skip if no email found

        const instantlyLead = transformToInstantlyLead(person, config.campaignId, config.vertical);
        await addLeadToInstantly(instantlyLead);
        synced++;

        // Respect rate limits: wait 200ms between individual pushes
        await new Promise(r => setTimeout(r, 200));
      }

      // Wait 2 seconds between enrichment batches
      await new Promise(r => setTimeout(r, 2000));
    }

    page++;
  }

  return { synced, pages: page };
}
```

### Vertical-Specific Search Configs

```typescript
const VERTICAL_CONFIGS = {
  apartments: {
    titles: [
      'Property Manager', 'Regional Property Manager',
      'Director of Property Management', 'Community Manager',
      'Asset Manager', 'VP of Property Management',
      'Director of Resident Services', 'Amenities Director',
    ],
    industries: ['real estate', 'property management'],
    locations: ['Las Vegas, Nevada', 'Henderson, Nevada', 'North Las Vegas, Nevada'],
    employeeRanges: ['11,50', '51,200', '201,1000'],
  },
  healthcare: {
    titles: [
      'Facilities Manager', 'Director of Facilities',
      'VP of Operations', 'Hospital Administrator',
      'Director of Support Services', 'Environmental Services Director',
      'Chief Operating Officer', 'Practice Manager',
    ],
    industries: ['hospital & health care', 'medical practice', 'health, wellness & fitness'],
    locations: ['Las Vegas, Nevada', 'Henderson, Nevada'],
    employeeRanges: ['51,200', '201,1000', '1001,5000'],
  },
  commercial: {
    titles: [
      'Building Manager', 'Facilities Manager',
      'Office Manager', 'Director of Operations',
      'Property Manager', 'VP of Corporate Services',
      'Workplace Manager', 'Director of Workplace',
    ],
    industries: ['commercial real estate', 'real estate', 'facilities services'],
    locations: ['Las Vegas, Nevada', 'Henderson, Nevada'],
    employeeRanges: ['51,200', '201,1000', '1001,5000'],
  },
};
```

---

## 5. Warmup Monitoring

### Check Warmup Status

```typescript
// Get warmup analytics for kurtis@kandevendtech.co
async function checkWarmupStatus(): Promise<{
  healthScore: number;
  sent: number;
  landedInbox: number;
  landedSpam: number;
  isReady: boolean;
}> {
  const res = await fetch('https://api.instantly.ai/api/v2/accounts/warmup-analytics', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      emails: ['kurtis@kandevendtech.co'],
    }),
  });

  const data = await res.json();
  const agg = data.aggregate_data?.['kurtis@kandevendtech.co'];

  return {
    healthScore: agg?.health_score || 0,
    sent: agg?.sent || 0,
    landedInbox: agg?.landed_inbox || 0,
    landedSpam: agg?.landed_spam || 0,
    isReady: (agg?.health_score || 0) >= 90 && (agg?.sent || 0) >= 50,
  };
}
```

### Warmup Health Targets

| Metric | Target | Action if Below |
|--------|--------|-----------------|
| Health Score | ≥ 90% | Don't start campaigns yet |
| Inbox Landing Rate | ≥ 95% | Check DNS records (SPF, DKIM, DMARC) |
| Total Sent | ≥ 50 warmup emails | Wait — warmup needs time |
| Spam Rate | < 2% | Pause warmup, check domain reputation |

### Warmup Timeline

| Week | Daily Warmup Emails | Campaign Emails | Total Daily |
|------|--------------------:|----------------:|------------:|
| 1 (Feb 2-8) | 5-10 (auto-ramp) | **0** — warmup only | 5-10 |
| 2 (Feb 9-15) | 10-20 (auto-ramp) | **0** — still warming | 10-20 |
| 3 (Feb 16-22) | 20-30 | **15-25** — start slow | 35-55 |
| 4 (Feb 23+) | 30-40 | **25-50** — ramp up | 55-90 |
| Month 2+ | 30-40 | **50-100** — full speed | 80-140 |

### Account Vitals Check

```bash
# Quick health check
curl -X POST https://api.instantly.ai/api/v2/accounts/test/vitals \
  -H "Authorization: Bearer $INSTANTLY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"accounts": ["kurtis@kandevendtech.co"]}'
```

---

## 6. Rate Limits & Best Practices

### Instantly Rate Limits
- **100 requests per 10 seconds** (workspace-wide)
- **600 requests per minute** (workspace-wide)
- Shared across API v1 and v2, all API keys
- HTTP 429 when exceeded

**Strategy:** Batch 100 leads at a time, 10-second pause between batches.

### Apollo Rate Limits
- Varies by plan (check `POST /api/v1/usage`)
- People Search (api_search): Free, no credit cost
- People Enrichment: 1 credit per person
- Bulk Enrichment: 1 credit per person, 50% slower rate limit
- Organization Search: 1 credit per result page

**Strategy:** Search for free, enrich only the best matches.

### Deliverability Best Practices

#### Domain Setup Checklist
- [ ] SPF record on kandevendtech.co
- [ ] DKIM record configured
- [ ] DMARC policy set (start with `p=none`)
- [ ] Custom tracking domain (optional — only add after warmup is healthy)
- [ ] MX records verified

#### Email Sending Rules
1. **Week 1-2:** Warmup ONLY. Zero campaign emails.
2. **Week 3:** Start with 15-25 emails/day. Text only. No links.
3. **Week 4+:** Ramp to 50/day. Can add one soft CTA link.
4. **Month 2+:** Scale to 75-100/day if health score stays >90%.
5. **Never exceed** 100 emails/day from a single account.
6. **Keep bounce rate under 3%.** Verify all emails before sending.

#### Email Content Rules
- **NO spam trigger words:** "free", "guaranteed", "act now", "limited time"
- **NO images** in first 2 weeks of campaigns
- **NO more than 1 link** per email (and only after warmup)
- **Personalize everything** — use {{first_name}}, {{company_name}} at minimum
- **Keep emails short** — 50-120 words max
- **Write like a human** — casual, conversational, no corporate speak
- **Vary subject lines** — A/B test every email in sequence
- **Reply to replies** within 24 hours — response time affects sender reputation

#### Compliance (CAN-SPAM)
- Include unsubscribe header (`insert_unsubscribe_header: true`)
- Include physical address in email signature
- Honor opt-outs immediately
- Don't use deceptive subject lines
- Identify message as an ad (when applicable)

---

## 7. Dashboard Integration Notes

### /outreach Page — 7 Tabs

| Tab | Data Source | Key Metrics |
|-----|-----------|-------------|
| **Overview** | Instantly Analytics API | Emails sent, opens, replies, meetings |
| **Campaigns** | Instantly Campaigns API | Active/draft/paused campaigns, lead counts |
| **Leads** | Instantly Leads API | Lead status, interest, verification |
| **Warmup** | Instantly Warmup Analytics | Health score, inbox vs spam, daily volume |
| **Apollo Sync** | Apollo Search + Enrichment | Credits used, leads found, sync status |
| **Templates** | Local / Instantly Templates | Email sequences, A/B variants |
| **Settings** | Both APIs | Account config, API key status, rate limit usage |

### Polling Schedule (Dashboard)

```typescript
const POLLING_INTERVALS = {
  warmupAnalytics: 4 * 60 * 60 * 1000,   // Every 4 hours
  campaignAnalytics: 15 * 60 * 1000,       // Every 15 minutes (when active)
  accountStatus: 60 * 60 * 1000,           // Every hour
  leadStatus: 30 * 60 * 1000,              // Every 30 minutes
};
```

### Webhook Events to Subscribe

```typescript
// Instantly webhook events to listen for
const WEBHOOK_EVENTS = [
  'lead.replied',           // Someone replied to our email
  'lead.opened',            // Email was opened
  'lead.clicked',           // Link was clicked
  'lead.unsubscribed',      // Lead unsubscribed
  'lead.bounced',           // Email bounced
  'lead.interest_changed',  // Interest status updated
  'campaign.completed',     // Campaign finished all sequences
];
```

---

## Appendix: Quick Reference Commands

```bash
# Check warmup health
curl -X POST https://api.instantly.ai/api/v2/accounts/warmup-analytics \
  -H "Authorization: Bearer $INSTANTLY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"emails":["kurtis@kandevendtech.co"]}'

# List all campaigns
curl https://api.instantly.ai/api/v2/campaigns?limit=10 \
  -H "Authorization: Bearer $INSTANTLY_API_KEY"

# Search Apollo for property managers in Vegas (free)
curl -X POST https://api.apollo.io/api/v1/mixed_people/api_search \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "'$APOLLO_API_KEY'",
    "person_titles": ["Property Manager"],
    "person_locations": ["Las Vegas, Nevada"],
    "per_page": 10
  }'

# Get Apollo credit usage
curl -X POST https://api.apollo.io/api/v1/usage \
  -H "Content-Type: application/json" \
  -d '{"api_key": "'$APOLLO_API_KEY'"}'
```
