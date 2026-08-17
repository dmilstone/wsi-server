package wsi_server.ui;

import java.util.List;

/**
 * Canonical copy for the Comprehensive User &amp; Administration Guide served at {@code /help}.
 * HTML and PDF renderers both use this text so the disclaimer cannot drift.
 * Viewer quick guide at {@code /help/viewer-guide.html} and the release cheatsheet at
 * {@code /help/admin-ops-guide.html} are separate documents.
 */
final class UserAdministrationGuideContent {

    static final String TITLE = "WSI Comprehensive User & Administration Guide";
    static final String SUBTITLE = "Viewer workflows, workstation isolation, and local ops LaunchAgent";

    static final String LEGAL_DISCLAIMER = """
            LEGAL DISCLAIMER: This software and documentation are provided for authorized \
            research and image-server administration only. They are not a substitute for \
            clinical judgment, validated diagnostic systems, or institutional SOP. Do not \
            enter patient identifiers, PHI, or other sensitive clinical information into \
            local ops tools, feedback forms, or shared logs. Operators remain responsible \
            for environment separation (development / staging / rehearsal / production), \
            de-identification of non-production images, and compliance with applicable \
            institutional, regulatory, and privacy requirements. Access is loopback- or \
            host-restricted where documented; do not expose administration endpoints via \
            proxy, port forward, or alternate bind address.""";

    record Bullet(String label, String body) {
    }

    record Section(
            String heading,
            String intro,
            List<Bullet> bullets,
            String protocolHeading,
            List<String> protocolSteps
    ) {
    }

    static List<Section> sections() {
        return List.of(
                new Section(
                        "1. Web Dashboard Image Ingestion Workflow",
                        "The slide ingestion pipeline is a manual three-click protocol on your local loopback operations panel.",
                        List.of(
                                new Bullet("The Environment",
                                        "The local operations dashboard listens strictly on http://127.0.0.1:8084/ and safely rejects external non-loopback clients."),
                                new Bullet("Pre-Ingestion Step",
                                        "Place each complete virtual microscope dataset inside one top-level directory under your local staging path (/Users/dm026/wsi-ingest-staging). Warning: Never move a lone .vsi file without its companion data folder.")
                        ),
                        "Execution Protocol",
                        List.of(
                                "Inspect your files in the directory staging pool.",
                                "Click 1 — Seal: type exactly SEAL to record the readiness assertion and first whole-tree observation.",
                                "Click 2 — Observe: wait for the configured quiet interval, then run Observe until the required observation count is met.",
                                "Optional: run Promotion dry-run to preflight without moving data.",
                                "Click 3 — Promote: type exactly PROMOTE to atomically move the verified folder into production (/Users/dm026/wsi-slides)."
                        )
                ),
                new Section(
                        "2. Workstation Annotation Safety & Isolation",
                        "To prevent cross-contamination of diagnosis data across different physical machines, drawing canvases are strictly sandboxed.",
                        List.of(
                                new Bullet("The Identity Key",
                                        "Every browser workstation generates a stable unique identity string on startup, stored as wsi.workstation.id in local browser storage and mirrored in your secure tracking cookies."),
                                new Bullet("The Header Loop",
                                        "The files annotation-adapter.js and annotation-store.js dynamically extract this machine tag and inject it as a custom X-WSI-User header into all network fetches."),
                                new Bullet("Data Segregation",
                                        "The server catches this machine fingerprint and isolates your drawing paths into distinct per-workstation folders inside your storage directory. It will never drop files back into the fallback public local bucket."),
                                new Bullet("Troubleshooting",
                                        "If an updated canvas displays blank parameters, perform a Hard Refresh (Cmd + Shift + R) to force your browser to discard its cached page state and re-transmit its unique workstation identity header.")
                        ),
                        null,
                        List.of()
                ),
                new Section(
                        "3. com.wsi.ops-dashboard LaunchAgent Maintenance",
                        "The workspace engine runs as a secure background macOS system daemon.",
                        List.of(
                                new Bullet("System Path",
                                        "Because macOS TCC blocks background launch scripts from running inside user directories like ~/Downloads, the production service lives securely in your system files at: ~/Library/Application Support/com.wsi.ops-dashboard/"),
                                new Bullet("LaunchAgent plist",
                                        "The job identifier is com.wsi.ops-dashboard. The plist is ~/Library/LaunchAgents/com.wsi.ops-dashboard.plist."),
                                new Bullet("Restarting Following Asset Changes",
                                        "If configuration parameters or scripts change, you can completely flush the server runtime cache by letting Cursor cycle the LaunchAgent service plist file.")
                        ),
                        null,
                        List.of()
                ),
                new Section(
                        "4. Related viewer help",
                        "This User Guide covers ingestion, workstation isolation, and the ops LaunchAgent. Viewer controls and the release cycle live in the other two manuals.",
                        List.of(
                                new Bullet("Viewer Quick Guide",
                                        "Open /help/viewer-guide.html for pan, zoom, channels, annotations, and export."),
                                new Bullet("Admin & Ops Guide",
                                        "Open /help/admin-ops-guide.html for environments, the monitored release cycle, logs, and rollback.")
                        ),
                        null,
                        List.of()
                )
        );
    }

    private UserAdministrationGuideContent() {
    }
}
