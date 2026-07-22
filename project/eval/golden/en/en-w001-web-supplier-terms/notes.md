# en-w001 — web page: supplier terms

First web-source case (Priority 5 Part A). `source.txt` is the FETCHER'S OUTPUT
— the readable text the narrow fetcher extracts from a fictional supplier's
terms page (title line first, exactly as the web SourceReader prepends it) —
because that is what production extraction sees; the fetch itself is covered by
`fetcher_hardening`, not the golden set.

What it probes: third-person business facts with amounts (never generalized),
and a dated term ("from 1 September 2026") that must land as a `valid_from`
interval so the web fact ages honestly. The Rijeka shipping-days line is
plausible but secondary — extracting it is fine, missing it costs nothing.

`source_date` plays the FETCH time: relative/temporal claims on a web page
resolve against when Cogeto read it ("as of").
