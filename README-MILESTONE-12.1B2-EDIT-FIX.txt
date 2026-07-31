Milestone 12.1B.2 editability fix

After a successful save with no newer edits pending, the visible annotation
collection is rebuilt from the server response. This gives annotations created
in the current browser session the canonical backend UUID and the same complete
geometry model as annotations loaded in a later session.

If a newer edit occurs while a PUT is in flight, the visible geometry is not
replaced; only backend IDs and metadata are reconciled and another save is queued.
