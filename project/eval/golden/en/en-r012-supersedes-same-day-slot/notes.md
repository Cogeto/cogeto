# en-r012: the update lands the same day

Two captures on one day, six hours apart, no validity interval on either. The
direction guard compares event times, and with no `valid_from` the event time
is the capture time, so this pair passes the guard only if the comparison keeps
its full timestamp resolution rather than collapsing to a calendar day.

Deliberately no `valid_from`: adding one would have made the same date the
event time on both sides, the guard would tie, and the case would stop testing
same-day ordering and start testing the tie-break instead. That is a different
case.
