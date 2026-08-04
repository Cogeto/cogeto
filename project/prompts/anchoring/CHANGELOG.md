# anchoring prompt changelog

**v0001** (2026-08-04, V2.1 item 4.2, spec 1.5): the source-context anchoring
call. One cheap pipeline-tier structured call over the document's opening plus
its filename, producing the subject entities, the document class and the
revision, each marked confident or uncertain. The output is stored on the
source (`source_context`, migration 0043) and injected into every chunk's
extraction call as a fenced DOCUMENT CONTEXT block; it is context, never a
fact, and it is never shown or cited as one. Fence discipline matches
extraction/v0004: the opening arrives inside the untrusted-data fence, and the
prompt's own labels are the only real labels.
