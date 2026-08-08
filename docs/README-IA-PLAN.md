# README information-architecture plan (future PR)

This is a planning artifact only. It does **not** change any README content.
Implement in a separate PR after non-obscuring viewer controls land.

## Problem

Operators and Cursor agents currently have many entry documents
(`README-MILESTONE-*.txt`, `README-MILESTONE-13.1.md`, `ops/README.md`,
`docs/ROADMAP.md`, `docs/VIEWER-QUICK-GUIDE.md`, `docs/WSI-INGESTION.md`, and
validation notes) without one canonical top-level navigation path.

## Goal

Create a single root `README.md` that is the only default entry point for:

1. what the system is
2. how to run / operate it
3. where durable planning lives
4. where feature/milestone history lives

## Proposed root README map

Keep the root README short. Link out; do not duplicate.

1. **Product** — one-paragraph WSI viewer description
2. **Quick start** — build/run pointers only (Maven/Spring entry, no ops dump)
3. **Operator path** — link `ops/README.md` + release cheatsheet
4. **Planning path** — link `docs/ROADMAP.md` as the durable priority record
5. **User guide** — link `docs/VIEWER-QUICK-GUIDE.md` (and HTML/PDF)
6. **Ingestion** — link `docs/WSI-INGESTION.md`
7. **History / milestones** — link a new `docs/milestones/` index rather than
   leaving dozens of root `README-MILESTONE-*` files as peer entry points
8. **Validation notes** — link `docs/*-VALIDATION.md` and diagnosis docs

## Migration steps (separate PR)

1. Add root `README.md` with the map above.
2. Move `README-MILESTONE-*` into `docs/milestones/` (or archive) and add an
   index page; leave stubs only if external links require them.
3. Ensure `docs/ROADMAP.md` remains the priority source; root README must not
   restate backlog items.
4. Keep `ops/README.md` authoritative for release/ops commands.
5. Do not mix skins, Z-stack, cache, or viewer-layout work into that PR.

## Acceptance checks

- A new contributor can find runbooks from root README in one hop.
- Cursor agents have one canonical “start here” path.
- No milestone README remains a competing root entry point.
- ROADMAP/help/ops content is linked, not copied.
