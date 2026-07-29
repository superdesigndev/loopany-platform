---
type: article
title: "Double down on what works — the scale half of the SEO system"
source: excerpted verbatim from the 2026-07-29 methodology article (Post 1)
---
# Double down on what works

![Daily Google clicks, late April through July: a flat line, a first spike, then the compounding climb](/template-assets/seo-try-keywords/seo-traffic.jpeg)

This is the scale half of the system — what happens after a bet proves. The full write-up, from the first bet to the 13,831-click curve, lives on the [SEO - Try New Keywords loop](/templates/seo-try-keywords); these are the parts that matter once a keyword has earned its engine.

## Bet on emerging, double down on what works

The whole strategy is two moves. Place cheap bets on emerging keywords. Double down on the ones that work.

The bet side:

- write a one-line thesis for the term ("this will form demand because...")
- ship a small bet: one main guide + up to 4 supporting pages, within days
- day-7 verdict from live Search Console data: scale or leave

Most bets are duds. One of ours ("loops vs graphs") totaled 16 impressions. Cost: one page, one afternoon. That's the point. The system works because being wrong is cheap, so you can afford to be wrong most of the time.

The double-down side is just as mechanical, because the data tells you where. One page drives 40% of our organic clicks, so it gets protected and interlinked, never experimented on. One page template earns 5% CTR while an identical sibling does 2.4%, so new pages get written in the winning shape. And when our emerging-keyword bet cleared its day-7 verdict, it got its own daily loop and kept shipping supporting pages while the window was open. The clicks decide what deserves more effort; we just read them.

Never scale silently, never kill silently. Every verdict gets a date and a number.

## Measurement rules we paid for

Three rules, each one bought with a real mistake:

1. Emerging terms get scored on position and impressions, never clicks. Demand hasn't arrived yet, so a clicks goal reads "126 clicks, meh" and quits right before the ground ripens. If you wait for clicks before investing, you will never rank an emerging keyword.

2. Read the daily series, never averages. Our dashboard reported average position 2.75 and called the keyword a confirmed win. The actual daily numbers: 1.42, 1.56, 2.27, 3.70, 4.86. Falling every single day. I caught it by eye on the daily chart; the average never fired. When a term is younger than your averaging window, the average hides the collapse completely. Also: Search Console returns zero-impression days as position 0, which makes a dead term look like it ranks #1. Filter them.

3. On mature pages, score clicks, but first remove the queries that can never click. We found 41 queries on one of our sites, 812 impressions, zero clicks ever: all AI assistants running searches, not humans. Navigational queries for other people's tools are the same. Counting them as opportunity sends you fixing pages that aren't broken.

## Rankings are rented

That same page went from position 1.4 to 7.3 in 7 days. I checked the actual search results: 8 dedicated articles existed that weren't there at launch. Impressions stayed flat the whole time, so demand was fine. Competition arrived, that's all.

The bet still paid off, because the value is front-loaded: you take 20-40% CTR while the results page is empty, and the supporting pages keep earning long after the head keyword gets crowded. Loop engineering shows the same pattern one stage later: its head keyword eventually fell to page 2 as demand moved on, but the cluster around it still earns about 1,900 clicks every 3 weeks, and one supporting article now out-earns the guide it links to.

Ride the window, then go find the next term. Defending position #1 forever is the incumbent's game, and you're not the incumbent.

## What stopped working (don't waste effort here)

Half of the standard playbook now actively hurts, and the clearest documented case is the self-promotional listicle: the "10 best X tools" post that ranks your own product #1. Lily Ray's research on Google's January 2026 update found sites running these lost 29-49% of their search visibility, and as few as 10 such pages was enough to get hit. It gets worse in AI search: when AI answers cite those listicles, 69% of the time the brand behind the listicle is excluded from the actual recommendation. Your listicle becomes a vote for the competitors you listed in it.

From the same research, also dead: bumping article dates without changing content (Google diffs versions), one comparison page per competitor at scale, FAQ farms, and AI-templated pages published with nobody editing.

We cleaned our own house on this. Rewrote our roundups so our product never self-ranks #1, and deleted comparison pages that had zero impressions after 3 months. If a page format's whole reason to exist is gaming the ranking, assume it's already being suppressed.

## The scale loops in practice

Add an enrichment loop (every 3 days, one page edit per run) once you have pages that rank but leak clicks. Our best single fix was a title edit worth about 280 clicks a month: the page ranked for 2,400 impressions of queries its title never mentioned. No new content, one PR.

Add a daily shipping loop only after a bet clears its day-7 gate, and write its retirement condition on day 1. Ours proposes shutting itself down if cluster clicks stay flat for 21 days.

Three failures worth stealing the fixes from:

- One loop spent 10 days optimizing internal links while the entire term shift sat unread in my own bookmarks. A loop grounded on its own analytics can't see the outside world. Every research run now starts from external signal.
- An enrichment run made up CLI flags by trusting the page's own stale copy as ground truth. Any new technical claim now gets verified against the official docs in the same run, with the URL in the PR.
- Loops drafted faster than we reviewed, and the backlog piled up invisibly for weeks. Same rule as my loops article: a loop has to respect your review bandwidth. Ours stop shipping at 3 open PRs.
