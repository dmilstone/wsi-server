package wsi_server.ui;

import java.util.List;

/**
 * Canonical copy for the Clean Administration &amp; Ops Manual served at {@code /help}.
 * HTML and PDF renderers both use this text so the disclaimer cannot drift.
 * Viewer quick guide at {@code /help/viewer-guide.html} is separate and must not be altered here.
 */
final class UserAdministrationGuideContent {

    static final String TITLE = "Standalone WSI Workspace Administration & Ops Guide";
    static final String SUBTITLE = "System Operational Environment: Secure Host-Isolated (Port 8084)";

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
                        "The slide ingestion pipeline is fully automated directly through your local web panel.",
                        List.of(
                                new Bullet("The Environment",
                                        "The local operations dashboard listens strictly on http://127.0.0.1:8084/ and safely rejects external non-loopback clients."),
                                new Bullet("Pre-Ingestion Step",
                                        "Place each complete virtual microscope dataset inside one top-level directory under your local staging path (/Users/dm026/wsi-ingest-staging). Warning: Never move a lone .vsi file without its companion data folder.")
                        ),
                        "Execution Protocol",
                        List.of(
                                "Inspect your files in the directory staging pool.",
                                "Choose **Yes** for Approve and Seal this Ingestion, then submit Seal & ingest.",
                                "The dashboard automatically waits through quiet observation checks.",
                                "It then runs **promote --dry-run** and, if clean, submits **PROMOTE** to **promote --step**.",
                                "The background engine atomically migrates the validated directory into your production slide root (/Users/dm026/wsi-slides)."
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
                                new Bullet("Restarting Following Asset Changes",
                                        "If configuration parameters or scripts change, you can completely flush the server runtime cache by letting Cursor cycle the LaunchAgent service plist file.")
                        ),
                        null,
                        List.of()
                )
        );
    }

    private UserAdministrationGuideContent() {
    }
}
