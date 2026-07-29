---
type: article
title: "How our blog went from 100 to 13,831 monthly clicks in 3 months"
source: x-article draft 2026-07-29 (Post 1, numbers approved)
---
# How our blog went from 100 to 13,831 monthly clicks in 3 months

![Daily Google clicks, late April through July: a flat line, a first spike, then the compounding climb](assets/seo-traffic.jpeg)

In April our blog got about 100 clicks from Google. In the last 28 days it got 13,831.

Same small site the whole time. No domain authority, no backlink budget, no ads. Two things changed: we started betting on keywords we can actually win, and we built agent loops to run most of the work.

The fastest example: three weeks ago we started ranking #1 for a keyword that didn't exist in June. That page did 964 clicks in its first 7 days at a 39% CTR (4 in 10 people who saw it clicked), and became the most clicked page on the site, almost 3,000 clicks in 3 weeks.

We also got a lot wrong along the way. One loop went blind for 10 days, and another shipped documentation for CLI flags it made up. This is the playbook I wish we had on day 1.

## Why the normal playbook fails small sites

Standard SEO advice: open a keyword tool, sort by volume, write the best page. That works when you have authority. We don't, and you probably don't either.

Here is what chasing volume got us: our "best ai coding agent" guide collected 80,338 impressions in Google and a 0.04% CTR. At one point 5 of our pages held 215k impressions and earned 947 clicks total. Ranking happened. Clicks didn't.

One question predicted every single one of these failures: does a primary source already exist for this query? If the official tool, the original doc, or an AI overview answer exists, searchers never reach you. You collect impressions and nothing else.

The flip side is where the whole strategy lives. On the same site, in the same month:

- brand new term where we're the first real answer: 21.9% CTR
- older term we also rank for: 2.7%
- sitewide average: 1.5%

Same site, same authority. Thin competition is the entire difference.

## Map the field before you bet

To reuse this in your own business, you first need a map. Pull what your competitors rank for (their blogs are public, and any SEO tool shows their top pages), pull your own Search Console data if you have any, and sort every keyword into three buckets:

1. High intent, hard: the money keywords your biggest competitors own. Someone searching these is close to buying, and every incumbent knows it. This bucket deserves your actual thinking time, because you can't win it head-on. The way in is the angle nobody covers: on one of our money terms, every ranking page defines the topic one way, and the people actually deciding to buy care about a different side of it entirely. That uncovered side is a page you can win.

2. High intent, easy: comparison searches, "X vs Y" terms, and any page of yours already sitting just off page 1. Quick wins. Collect these first, they're often a title fix away.

3. Low intent, easy: informational searches nobody fights over. Individually small, but this is where emerging keywords live, and it's where a new site builds the track record that lets it fight for bucket 1 later.

The classic mistake is pouring everything into bucket 1 head-on because that's where the money is. Our sequence: take bucket 3 fast (next section), collect bucket 2 along the way, and let those two earn you the authority to attack bucket 1 from an angle.

## Be first, not best

Our first bet was "loop engineering". In June the term barely registered in Search Console. We shipped a full guide plus supporting articles while the results page was still empty, and watched it go from zero to about 4,400 weekly impressions in a month.

Then on July 18, a post landed in my bookmarks: Hamel Husain declaring loop engineering dead and crowning a successor term. I checked Search Console: about zero searches for the new term. Two days later we had a main guide plus 4 supporting articles live for it.

Day 7: position 1.5 on the exact keyword, 964 clicks, 39% CTR.

A small site can never outrank LangChain for "AI agents". But on a term that's 2 weeks old there is nobody to outrank. You just have to arrive before the crowd, and the crowd takes about 10 days.

Best part: the radar is your own feed. Keyword tools lag weeks behind what builders just started searching. The posts you bookmark today ARE next month's keywords;

One bonus play: when a new term kills an old one, people search the displacement itself. The comparison page we shipped for those "is loop engineering dead" searches does 295 clicks a week on its own. Ship the "X is dead" and "X vs Y" pages on purpose.

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

## The loop setup to copy

We run 4 loops now, but we got here by breaking things. Start smaller:

Week 0, instrument only. A 75-line script hitting the Search Console API, no dependencies. Find your breadwinner (for us, one page is 40% of all organic clicks). Give it a 14-day cooldown, never experiment on it. Tag the bot queries.

Loop 1, a weekly scout. Reads fresh external signal (bookmarks, feeds, niche communities), diffs it against your existing coverage, places at most one cheap bet as a PR. A human merges. Skipping a week is a valid outcome; ours skipped 3 weeks in a row and that was the system working.

Loop 2, a weekly scorecard. Reads live data, issues dated verdicts on open bets, never ships anything. Keep measuring and acting in separate loops, or one bad week rewrites your whole strategy.

Add an enrichment loop (every 3 days, one page edit per run) once you have pages that rank but leak clicks. Our best single fix was a title edit worth about 280 clicks a month: the page ranked for 2,400 impressions of queries its title never mentioned. No new content, one PR.

Add a daily shipping loop only after a bet clears its day-7 gate, and write its retirement condition on day 1. Ours proposes shutting itself down if cluster clicks stay flat for 21 days.

Three failures worth stealing the fixes from:

- One loop spent 10 days optimizing internal links while the entire term shift sat unread in my own bookmarks. A loop grounded on its own analytics can't see the outside world. Every research run now starts from external signal.
- An enrichment run made up CLI flags by trusting the page's own stale copy as ground truth. Any new technical claim now gets verified against the official docs in the same run, with the URL in the PR.
- Loops drafted faster than we reviewed, and the backlog piled up invisibly for weeks. Same rule as my loops article: a loop has to respect your review bandwidth. Ours stop shipping at 3 open PRs.

## Checklist

- [ ] Search Console API access + breadwinner identified before anything ships
- [ ] every new keyword: written thesis, max 5 pages, a day-7 verdict date
- [ ] doubling down goes where the data points: winning template, breadwinner, biggest click leak
- [ ] emerging terms scored on position + impressions, mature pages on clicks
- [ ] daily series only, zero-impression days filtered
- [ ] research starts from external signal, never your own analytics
- [ ] every technical claim checked against primary docs
- [ ] measurement loop separated from shipping loops
- [ ] a human merges everything

That's the machine behind the curve at the top: about 100 clicks a month in April, 13,831 in the last 28 days. And the composition matters more than the total. Most of the recent jump came from one emerging keyword we caught early, not from publishing volume.

We open-sourced the whole method as the loop templates on this site — this page is the bet manager; its sibling, SEO - Scale Proven Keywords, scales the winners.

Copy it. Adapt it to your site.

The best keyword of next month doesn't exist yet. Build the thing that notices it first.
