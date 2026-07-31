Milestone 12.1B.2 - Persist Annotorious edits
=============================================

Implemented:
- Debounced PUT of the complete AnnotationCollection after create, move/resize, or delete.
- Server-normalized UUIDs and timestamps are applied back to Annotorious after a successful save.
- Pending edits are flushed before switching images.
- Overlapping save requests are serialized and stale responses are ignored.
- Invisible or otherwise non-displayed backend annotations are preserved during whole-document saves.
- Backend validation errors are reported in the browser console without silently discarding local edits.

Verification:
1. Start the server and open a slide.
2. Draw a rectangle and wait about half a second.
3. Confirm the console reports "AnnotationAdapter: saved 1 annotation".
4. Reload the browser or switch away and back; the rectangle should return.
5. Move/resize it, reload, and confirm the new geometry persists.
6. Delete it, reload, and confirm it remains deleted.
