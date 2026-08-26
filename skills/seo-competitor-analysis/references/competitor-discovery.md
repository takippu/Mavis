# Competitor discovery method

Use this method whenever the skill must find competitors. Adapt the breadth to the requested scope, but do not skip live discovery.

## 1. Establish the target entity

Extract from the live site:

- plain-language product category;
- primary audience and buyer;
- geography and service area;
- supported languages;
- core job-to-be-done;
- important features and differentiators;
- commercial model and conversion action;
- category terms already used in titles, headings, body copy, navigation, schema, and URLs.

Write a one-sentence target definition before generating queries. This prevents adjacent but irrelevant products from dominating the candidate set.

## 2. Build a query basket

Create queries across distinct intent clusters rather than many cosmetic rewrites of one phrase.

| Cluster | Query pattern | Purpose |
|---|---|---|
| Category | `[category]`, `[category] [country]` | Finds direct category leaders |
| Problem | `how to [job]`, `best way to [job]` | Finds problem owners and educational competitors |
| Solution/mechanism | `[mechanism] for [audience/use case]` | Finds products positioned around how the result is delivered |
| Feature | `[feature] [category]`, `[category] without [friction]` | Finds feature-led entrants |
| Use case | `[category] for [event/industry/persona]` | Finds vertical competitors |
| Commercial | `best [category]`, `[category] pricing`, `[category] app` | Finds high-intent alternatives |
| Comparison | `[category] vs [substitute]`, `[brand] alternatives` | Finds substitutes and comparison publishers |
| Local language | Native-language equivalents and natural hybrids | Finds local brands that English-only research misses |
| Branded | Target brand, aliases, domain, and `site:` checks | Measures target discovery and entity clarity |
| AI-style question | `What is the best way to...`, `Which tool lets...` | Tests answer-shaped phrasing and cited sources when an answer surface is available |

Use autocomplete, related searches, Search Console, Trends, Ads Keyword Planner, or other actual query data when accessible. Label the source. If no volume data is available, do not call a phrase high-volume; describe observable suggestion or recurrence evidence instead.

For multilingual markets, search both the local language and English. Include natural mixed-language phrasing when the audience uses it. Do not translate mechanically if local wording differs.

## 3. Collect and normalize candidates

For each query, record the exact query and language/locale, result position when observable, result URL and normalized registrable domain, title/snippet, result class, and which intent cluster produced it.

Normalize `www` and protocol variants to one domain. Keep locale paths and product subdomains in the evidence because they can explain relevance. Exclude the target domain from candidate scoring, but record whether it appeared and for which queries.

Do not silently discard publishers, directories, or communities. They are not direct product competitors, but they reveal which sources own the SERP and may become citation or partnership targets.

## 4. Rank direct competitors

Use evidence across the whole basket. A useful 100-point model is:

- cross-cluster coverage: 0–30;
- search prominence across observed results: 0–20;
- verified product and audience fit: 0–25;
- country/language fit: 0–10;
- relevant landing-page/content depth: 0–10;
- discoverable external or answer-engine corroboration: 0–5.

This score is a comparison aid, not an industry metric. Show the component evidence or use High/Medium/Low confidence if rank positions or coverage are incomplete. Never turn sparse observations into false numeric precision.

Normally shortlist a candidate when it appears in at least three distinct query clusters and offers a directly substitutable product. A domain may qualify from one cluster when it ranks prominently for the exact primary category and its product fit is verified. Explain every exception.

Keep three lists:

1. **Direct search competitors:** users could reasonably choose them instead of the target.
2. **Indirect substitutes:** different products or workflows that solve the same job.
3. **SERP owners:** publishers, directories, communities, marketplaces, and platforms that rank or are cited but are not substitutable products.

## 5. Verify each shortlisted domain

Open the homepage and the most relevant ranking page. Capture:

- homepage title and meta description;
- H1 and early visible positioning;
- topics and keywords used naturally;
- product mechanism, audience, geography, and differentiation;
- important landing pages and URL structure;
- content depth and use-case coverage;
- navigation and internal-link strategy;
- canonical, indexability, sitemap, robots, and hreflang where relevant;
- Organization, Product, SoftwareApplication, FAQ, HowTo, Breadcrumb, or other matching structured data;
- real review, partner, founder, press, profile, or backlink signals that are publicly discoverable;
- why a search or answer engine would consider the page relevant;
- weaknesses or gaps the target can address without copying.

When a page is client-rendered or blocks extraction, use search snippets, rendered browsing, sitemaps, and other direct evidence. State the limitation instead of treating missing raw HTML as missing content.

## 6. Test the target's footprint

Search exact brand names and aliases, the bare domain, `site:target-domain` when supported, brand plus category, category plus country/language, and the exact distinctive product description.

Do not equate one search provider's absence with confirmed Google deindexing. Search Console URL Inspection and Page indexing are the sources of truth for Google. If unavailable, label public-search absence as an observed warning and make Search Console diagnosis the next action.

## 7. Saturation and confidence

Run discovery in batches. Add new queries around unexplained candidates, missing intent clusters, and local phrasing. Stop when two consecutive batches add no credible direct competitor, or when further searching would not change the decision.

Report the number of queries and clusters sampled, languages/locales covered, discovery date, available search/answer surfaces, automatically discovered direct competitors, user-supplied candidates confirmed/downgraded/rejected, and unavailable data.

