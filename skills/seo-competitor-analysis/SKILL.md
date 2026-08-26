---
name: seo-competitor-analysis
description: Discover and analyze a site's real organic-search competitors from live search results, multilingual query intent, recurring domains, and verified on-page evidence. Use for SEO competitor research, search-visibility gaps, category positioning, GEO/AEO comparisons, or questions such as "who are my search competitors?"; not for general corporate or financial competitor analysis without a search-discovery objective.
---

# SEO Competitor Analysis

Find the competitors from current evidence instead of requiring the user to name them. A supplied competitor list is a set of hypotheses to verify, not the final answer.

## Choose the scope

Infer the smallest mode that satisfies the request:

- **Discovery:** identify and rank the actual organic-search competitors.
- **Competitive audit:** discovery plus on-page, technical, content, authority, keyword, and entity-gap analysis.
- **Audit and implementation:** perform the competitive audit, then change the user's site only when implementation is explicitly requested. Preserve normal approval and repository boundaries.

Ask for the target URL or product only when it cannot be inferred. Infer language, country, audience, and conversion goal from the site and request; ask a question only if ambiguity would materially change the competitor set.

## Required discovery workflow

Live search results are volatile, so browse the web for every competitor-discovery run. Read [references/competitor-discovery.md](references/competitor-discovery.md) before searching.

1. Audit the target homepage and important landing pages enough to state the product, audience, geography, business model, and primary jobs-to-be-done.
2. Build a query basket across category, problem, solution, feature, use-case, comparison, local-language, English, and branded intent. Use live suggestions or query data when available.
3. Search the basket and record recurring domains. Exclude the target domain. Keep direct products, substitutes, publishers/directories, and irrelevant noise in separate classes.
4. Rank candidates by cross-query recurrence, search prominence, product fit, market/language fit, and corroborating evidence. Do not let one query determine the shortlist.
5. Open each shortlisted competitor's homepage and at least one relevant landing page. Verify what it actually offers, its title, H1, positioning, information architecture, internal links, structured data, and the reason it qualifies.
6. Search the target brand/domain and competitor brands for discoverable third-party mentions. Use paid backlink or keyword data when available; never invent volume, domain authority, traffic, or link counts.
7. Stop discovery after two consecutive query batches reveal no new credible direct competitor, or when the evidence is sufficient for the requested scope. State coverage and limitations.

## Analysis rules

- Separate **search competitors** from business competitors. A directory, editorial article, marketplace, or social platform can own a SERP without selling the same product.
- Prefer domains recurring across multiple intent clusters. Include a single-query candidate only when it is an exact category match with strong verified product fit.
- Treat snippets as discovery evidence, not proof. Verify claims on the actual page.
- Audit the current live target and competitors; do not rely on remembered or previous versions.
- Use primary and official sources for technical-search guidance. Cite every externally verifiable current claim near the claim.
- Distinguish observed facts, reasonable inferences, and unavailable data.
- Do not recommend doorway pages, keyword stuffing, hidden copy, fake reviews, fake entities, bulk AI content, or fabricated backlinks.
- For AI search, focus on crawl/index eligibility, direct entity descriptions, consistent naming, visible answer-ready content, matching structured data, and real external corroboration. Do not present an `llms.txt` file as a ranking fix without evidence.

## Deliverables

For discovery-only work, provide:

- target/category diagnosis;
- query basket and market/language coverage;
- ranked direct-competitor shortlist with discovery evidence;
- separate substitute and SERP-publisher lists;
- why each shortlisted domain qualifies;
- important limitations and the next data source to connect.

For a competitive audit, also read [references/audit-deliverable.md](references/audit-deliverable.md) and provide the evidence-backed gap analysis and prioritized roadmap defined there.

When implementation is requested, inspect the actual codebase and framework documentation, show the high-confidence scope before major changes, preserve unrelated work, implement only supported changes, and validate proportionally. Never commit, push, deploy, submit URLs, or contact third parties unless the user authorizes that action.

