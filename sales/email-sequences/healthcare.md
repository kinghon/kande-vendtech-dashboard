# Healthcare Facility Email Sequence
## Target: Facilities Managers, Hospital Administrators, Directors of Support Services

> **Vertical:** Hospitals, medical offices, clinics, rehab centers, senior care  
> **Persona:** Decision-makers for facility amenities and support services  
> **Pain points:** Staff satisfaction, patient/visitor convenience, managing multiple vendors, budget constraints  
> **Value prop:** Staff/visitor convenience amenity with zero budget impact and zero facility management

---

## Personalization Tokens

| Token | Source | Example |
|-------|--------|---------|
| `{{first_name}}` | Apollo | Michael |
| `{{company_name}}` | Apollo | Valley Health System |
| `{{title}}` | Apollo | Director of Facilities |
| `{{city}}` | Apollo/Custom | Las Vegas |
| `{{facility_type}}` | Custom variable | hospital |
| `{{sender_first}}` | Instantly | Kurtis |

---

## Email 1: The Opener
**Send:** Day 0 (immediate)  
**Subject Lines (A/B test):**
- A: `{{first_name}}, quick question about staff amenities`
- B: `vending at {{company_name}} — quick question`

**Body:**
```
Hi {{first_name}},

I work with healthcare facilities in {{city}} on their vending programs and had a quick question for you.

Are the vending machines at {{company_name}} currently meeting the needs of your staff and visitors? I ask because most facilities I talk to either have outdated machines with limited options, or they're dealing with a vendor who's slow on restocking and maintenance.

We provide fully managed, modern cashless vending machines at zero cost to the facility. We handle installation, stocking, maintenance — everything. Your team gets convenient 24/7 access to snacks, drinks, and essentials without adding anything to your plate.

Is this something worth a quick conversation?

Kurtis Hon
Kande VendTech
kurtis@kandevendtech.co
```

**Word count:** 119  
**CTA:** Soft question  
**Notes:** Opens with a question that implies expertise. Addresses the "bad vendor" pain point that almost every healthcare facility has experienced.

---

## Email 2: The Healthcare-Specific Value
**Send:** Day 3  
**Subject Lines (A/B test):**
- A: `Re: {{first_name}}, quick question about staff amenities`
- B: `what I'm hearing from facilities teams in {{city}}`

**Body:**
```
{{first_name}},

Following up on my last note. Here's why healthcare facilities specifically benefit from upgrading their vending:

→ Night shift staff need 24/7 access (cafeteria closes, vending doesn't)
→ Visitors spending hours in waiting areas appreciate the convenience
→ Cashless payment means less cash handling and fewer service calls
→ Modern machines with healthy options align with healthcare facility standards
→ Zero cost, zero management — we handle it all

I keep hearing the same thing from facilities managers: "I didn't realize switching could be this easy." Most of the time it's a 15-minute conversation and we take it from there.

Worth 15 minutes?

Kurtis
```

**Word count:** 109  
**CTA:** "Worth 15 minutes?" — specific time ask  
**Notes:** The night shift angle is huge for healthcare. It's a pain point that facility managers know intimately but vendors rarely address.

---

## Email 3: The Operational Angle
**Send:** Day 7  
**Subject Lines (A/B test):**
- A: `one less thing to manage`
- B: `{{first_name}}, thought of your team`

**Body:**
```
Hi {{first_name}},

I know facilities teams in healthcare are stretched thin — you're juggling HVAC, compliance, security, and a hundred other things. Vending machines probably aren't at the top of your priority list.

That's kind of the point.

We take vending completely off your plate. If a machine needs restocking, we handle it. If something breaks, we fix it. You never get a call, never manage a vendor relationship, never deal with complaints.

Your team just gets a better amenity, and the facility earns a commission check every month for the floor space.

If you've got a few minutes this week, I'd love to see if this makes sense for {{company_name}}.

Kurtis
```

**Word count:** 114  
**CTA:** "A few minutes this week"  
**Notes:** This email validates their workload and positions the offer as a problem removal, not an addition. "That's kind of the point" is a deliberate pattern interrupt.

---

## Email 4: The Breakup
**Send:** Day 12  
**Subject Lines (A/B test):**
- A: `should I close the loop?`
- B: `not sure if this landed`

**Body:**
```
{{first_name}},

I've sent a couple of notes about upgrading the vending at {{company_name}} and I want to be respectful of your time.

Usually when I don't hear back, it's one of three things:

1. Timing isn't right (totally fine — can revisit later)
2. Someone else handles vendor decisions for the facility
3. You already have a great vending partner (and if so, I'm curious who)

If it's #2, would you mind pointing me the right way? I'd really appreciate it.

Otherwise, no hard feelings — just wanted to make sure this didn't get buried in your inbox.

Kurtis Hon
Kande VendTech
kurtis@kandevendtech.co
```

**Word count:** 106  
**CTA:** Referral request  
**Notes:** The curiosity angle in #3 sometimes gets responses. People love to share who they're using, especially if they're unhappy. #2 is the main play — referrals from the wrong contact to the right one convert well.

---

## Email 5 (Optional): The Hail Mary
**Send:** Day 21  
**Subject Lines:**
- A: `{{first_name}} — last note from me`
- B: `quick thought`

**Body:**
```
{{first_name}},

I'll keep this super brief — this is my last email.

If you ever want to explore upgrading the vending setup at {{company_name}}, I'm a quick email away. Zero cost, full service, and we work around your facility's schedule for installation.

Hope you're having a good week.

Kurtis
```

**Word count:** 47  
**CTA:** None — pure offer  
**Notes:** Mentioning "we work around your facility's schedule" is a subtle differentiator. Healthcare facilities can't just shut down a wing for installation — showing you understand that signals expertise.

---

## Sequence Timing Summary

| Email | Day | Purpose | Tone |
|-------|-----|---------|------|
| 1 | 0 | Introduce + qualify | Professional, consultative |
| 2 | 3 | Healthcare-specific value | Helpful, insider knowledge |
| 3 | 7 | Operational relief angle | Empathetic, solution-focused |
| 4 | 12 | Breakup + referral | Respectful, direct |
| 5 | 21 | Hail mary | Warm, brief |

## Healthcare-Specific Notes

### Best Sending Times
- **Tuesday-Thursday, 7:00-9:00 AM** — facilities managers check email before the day gets chaotic
- **Avoid Mondays** — meetings, weekend catch-up
- **Avoid Fridays** — mental checkout, planning mode

### Title Targeting Priority
1. Facilities Manager / Director of Facilities (primary decision maker)
2. Director of Support Services / Environmental Services Director
3. Hospital Administrator / COO (larger facilities)
4. Practice Manager (smaller clinics — also handles facilities)
5. VP of Operations (multi-site health systems)

### Compliance Note
- Do NOT send to clinical email addresses (doctor/nurse emails)
- Target administrative/operational staff only
- HIPAA is not relevant to vending, but respect the healthcare context — keep emails professional

## Expected Metrics

| Metric | Target | Good | Great |
|--------|--------|------|-------|
| Open Rate | 40%+ | 45-55% | 60%+ |
| Reply Rate | 2-4% | 4-6% | 8%+ |
| Positive Reply | 1-2% | 2-3% | 4%+ |
| Meeting Book | 0.5-1% | 1-2% | 2%+ |
| Bounce Rate | <3% | <2% | <1% |

> **Note:** Healthcare email lists tend to have higher bounce rates because staff turnover is high and hospital email systems have aggressive spam filters. Verify ALL emails before adding to campaigns.
