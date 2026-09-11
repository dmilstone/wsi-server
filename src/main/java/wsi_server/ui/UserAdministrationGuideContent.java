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
            institutional, regulatory, and privacy requirements. Access is loopback by \
            default; a LAN bind is opt-in with CIDR and Host allowlisting. Do not expose \
            administration endpoints via reverse proxy or to the public internet.""";

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
                                        "The local operations dashboard listens on https://127.0.0.1:8084/ by default. Non-loopback clients are rejected unless a CIDR allowlist is configured."),
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
                        "4. Viewer Multi-view, channel viewer, and shortcuts",
                        "The viewer View menu and image right-click menu (not annotation right-click) control Multi-view and the channel viewer. Click ? for the live shortcut legend; Shift-click ? for the Help directory.",
                        List.of(
                                new Bullet("Multi-view",
                                        "Set grid size (1x1, 1x2, 2x1, 2x2, 3x3), add or remove a row or column, then click a pane or drag a slide onto it. A new image fits the pane it occupies; changing the grid re-fits open images. Close images in a row or column before removing it."),
                                new Bullet("Synchronize viewers",
                                        "Pan and zoom stay locked across panes once two or more panes have images (Ctrl+Shift+S / Cmd+Shift+S / Ctrl+Alt+S). Match viewer resolutions uses each slide's pixel size. Close, detach, or attach applies to the active pane."),
                                new Bullet("Show channel viewer",
                                        "Opens a detached window of each visible channel plus Composite, following the cursor by default. Right-click that window to sync to cursor or viewer center, change zoom, or show all channels."),
                                new Bullet("Scale bars and Z-stack",
                                        "Each occupied pane shows its own scale bar when calibrated. View ▸ Open Z-stack controller reopens the focal-plane window. Alt+wheel or arrow keys change focal plane. Double-click the magnification readout to type an exact value."),
                                new Bullet("Left pane and Hierarchy",
                                        "Tabs are Slides, Image, Annotations, and Hierarchy. Hierarchy lists the image, annotations, and detections as a tree. Select a row for measurements or description; expand, collapse, lock, or delete from the toolbar; filter the Key/Value table by key."),
                                new Bullet("Cell display",
                                        "View ▸ Cell display switches detections among nuclei and cell boundaries, nuclei only, boundaries only, and centroids."),
                                new Bullet("Delete object",
                                        "Delete or Backspace removes selected annotations and cannot be undone. If the annotation contains detections or nested objects, Yes keeps those descendants, No deletes them too, and Cancel leaves everything."),
                                new Bullet("AI Labs",
                                        "Selected annotation clips detections to the real outline, not the bounding box. Choose whether nuclei that cross the border are excluded, included, or truncated. Prefer Nuclear channel for fluorescence StarDist. Heat Map shows Quantify colors after a successful run."),
                                new Bullet("Brightness & Contrast",
                                        "Double-click Channel min or max to type a value. Drag the histogram min/max lines. An empty colored checkbox outline means the channel is off; a × means it is on."),
                                new Bullet("Keyboard shortcuts",
                                        "A/N/D visibility; F and Shift+F fills; H left browser (Slides/Image/Annotations/Hierarchy); M/S/R/O/L/P/V/B/W/./Z/C tools; Enter seals a polygon; Delete removes selected annotations (with the descendant prompt when needed). Full list is on the ? legend.")
                        ),
                        null,
                        List.of()
                ),
                new Section(
                        "5. Related viewer help",
                        "This User Guide covers ingestion, workstation isolation, the ops LaunchAgent, and the current viewer Multi-view, Hierarchy, and channel-viewer behavior. The release cycle lives in the Admin & Ops Guide.",
                        List.of(
                                new Bullet("Viewer Quick Guide",
                                        "Open /help/viewer-guide.html for pan, zoom, Multi-view, Hierarchy, channel viewer, annotations, and export."),
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
