# hr-x004: CSV s točkom-zarezom u Windows kodnoj stranici

The case the encoding fallback exists for, and the reason its default is
windows-1250 rather than windows-1252 (V2.1 item 4.1, issue B5).

`Željka Perić`, `Ivan Šarić`, `Božidar Kovačić` and `Ana Đurić` between them use
č, ć, ž, š and đ. Those five letters live at different code points in 1250 and
1252, so a fallback tuned for Western Europe returns names that look almost
right and are wrong, which is worse than failing: the facts would be stored,
verified against the same mangled span, and remembered.

Croatian is the non-English corpus language, so 1250 is the honest default. The
choice only affects bytes at or above 0x80, so no English file is touched by it,
and the encoding actually used is recorded on every read.

## What this case measured that was not the point

Same as en-x004: the amounts extract, the contact columns do not, and the four
Croatian names are here to prove the windows-1250 fallback, which they do. The
contact labels are `must_extract: false` for the reason written in en-x004's
notes, and the gap is recorded rather than hidden.
