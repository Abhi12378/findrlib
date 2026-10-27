# Resource Finder — implemented feature inventory

Last checked: 24 October 2026. This describes the local app in this package. Source availability and result counts can change.

## Discovery
- Public Home page with app explanation, how-to steps, resource categories, example searches, and source-health panel.
- Search the bundled Public APIs catalog (2,169 entries at the last refresh) and live GitHub, YouTube, web, Open Library, OpenAlex, document, and tools/app sources. Known naming variants, such as LIC AO → LIC AAO, are expanded for live search; four verified LIC AAO PDFs and a paper collection page are bundled for fallback.
- Search by topic or task; switch among All, APIs, GitHub repositories, YouTube videos, books, research papers, websites, docs/files, and tools/apps. The exact abbreviation `OS` is searched as `operating systems` while retaining the user's displayed query.
- Filters for verified free access, open source, API-key requirement, programming language, and document format.
- Load more provider results; relevance ranking, URL deduplication, weak-snippet cleanup, rejection of unrelated public-feed hits, and suppression of links found to return 404/410. An optional server-side Brave Search API key expands live web and document coverage; no key is bundled.
- Resource cards link to the original publisher. Curated guides have setup notes and code examples; other live resources may provide only their publisher link.
- Bounded page crawler checks selected results, respects robots.txt, limits requests and page size, blocks private/local addresses, and caches public page metadata for 24 hours. A page check establishes reachability at that time, not factual accuracy.

## Source-specific detail
- YouTube cards can show publisher thumbnails, public view counts, and posting times where available. A bounded watch-page check adds dates and counts when found. Reviewed Aptitude videos appear immediately when live video search has no results; external search links no longer inflate resource counts.
- OpenAlex 429 responses are cooled down and fall back to keyless Crossref citation metadata, with full-text access left unverified. Open Library 422 responses trigger a simpler book query retry.
- Docs & files accepts indexed PDF, Word, and PowerPoint links. Cards label free, paid, or access unverified according to available evidence, with a format filter.
- Tools & apps uses likely product pages and website favicons when available. GitHub and YouTube marks, file icons, category icons, and navigation icons are bundled from third-party professional icon sets with attribution.
- The API catalog refreshes at midnight while the app runs, catches up on next launch, and supports Refresh now. A supplied Windows Scheduled Task installer can refresh it while the app is closed; installation has not been verified in this environment.

## Workspace and navigation
- Guest search without a personal saved workspace.
- Google Identity Services button and server-side ID-token verification are implemented. End-to-end login remains unverified because Google has rejected the configured local origin in this browser.
- After verified sign-in, bookmarks, collections, and recent searches are stored under the account identifier in this browser's localStorage. Export and import use JSON. Logout clears the active account from memory and screen; the account's local data can reopen after another verified sign-in.
- Responsive slide-out navigation, outside-click/Escape close, active-page and active-filter indication, keyboard search shortcut (Ctrl K on Windows, Command K on Mac), and a profile menu.
- About, Terms of Service, Privacy Policy, and copyright pages are present as drafts.

## Operations
- Provider health shows status, response times, recent errors, and last-check type without storing user search text. Result pages omit raw provider errors and external search shortcuts; empty results use a plain-language state.
- Automatic, low-rate public checks start after launch for unseen providers; Tools & apps is checked first. Degraded providers are rechecked; a fallback never counts as a successful recovery. Rate-limited, blocked, busy, and login-required sources are not retried in a loop.
- The Home panel refreshes health every 10 seconds while visible. A lightweight /api/health endpoint and check_health.py are included.
- Support form prepares an email draft if a support address is configured. Without one, it downloads an unsent text draft.
- Windows executable, Python batch launcher, test suite, relevance fixture, and Lighthouse mobile-audit script are included.
- The `launch.bat` browser launcher starts a hidden local server and attempts to install a Windows Task Scheduler watchdog. The watchdog checks every ten minutes and starts or restarts the server when missing or outdated. Its installation must succeed in a normal Windows session.

## Not implemented or not verified for public launch
- Sponsored placements, payments, premium collections, and synchronized team bookmarks are planned.
- A complete Google login, installed scheduled task, Lighthouse score, public HTTPS hosting, production alert destination, support mailbox, and owner-approved legal policies remain unverified or incomplete.
- No source can guarantee exhaustive results, permanent free access, current licensing, or factual accuracy. Provider outages can leave a source degraded even with automatic rechecks.
