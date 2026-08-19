/**
 * Archived right-column layout package.
 *
 * Extracted from index.html so the live viewer can use a full-width canvas
 * and a top toolbar. Drop this module back into the page if the original
 * sidebar needs to be restored without rewriting markup.
 *
 * Usage:
 *   const host = document.createElement("div");
 *   host.innerHTML = LegacyRightPanelLayout.html;
 *   document.querySelector(".workspace")?.appendChild(host);
 */
const LegacyRightPanelLayout = {
    id: "legacy-right-panel",
    version: "2026-08-19",
    description: "Original right-column display controls: channels, Z-stack, AI Labs, workstation admin.",
    css: `
        :root { --right-panel: 360px; }
        .workspace { grid-template-columns: var(--left-panel) 6px minmax(360px,1fr) 6px var(--right-panel); }
        .workspace > #right-resizer { grid-column: 4; grid-row: 1; }
        .workspace > #channels-panel { grid-column: 5; grid-row: 1; }
        #channels-panel {
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        .right-column-top {
            position: sticky;
            top: 0;
            z-index: 21;
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px 10px 8px;
            border-bottom: 1px solid var(--border);
            background: rgba(17, 24, 33, .96);
            backdrop-filter: blur(10px);
        }
        .right-column-top .panel-secondary-actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 12px;
            margin: 0;
            padding: 0;
            border: 0;
        }
        .right-stack-controls {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 0;
            padding: 0;
            border: 0;
            background: transparent;
        }
        .right-stack-controls[hidden] { display: none !important; }
        #channels { flex: 1 1 auto; min-height: 0; padding: 8px 10px 12px; overflow: auto; }
        .display-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        #reveal-right { right: 0; border-right: 0; border-radius: 9px 0 0 9px; }
        .workspace.right-collapsed #channels-panel,
        .workspace.right-collapsed #right-resizer { display: none; }
    `,
    html: `
    <button id="reveal-right" class="panel-reveal" type="button" aria-label="Show display controls">Show channels</button>
    <div id="right-resizer" class="resize-handle" role="separator" aria-label="Resize display controls"></div>
    <aside id="channels-panel" aria-label="Display controls">
        <div class="right-column-top">
            <div class="panel-secondary-actions">
                <button id="show-advanced-channel-palette" class="fcp-launch-btn" type="button"
                        title="Show Advanced Channel Palette"
                        aria-label="Show Advanced Channel Palette"
                        aria-pressed="false">◐</button>
                <a id="pilot-feedback-link" class="panel-secondary-link" href="/pilot-feedback/" title="Open full-page pilot feedback form (shortcut F in viewer)">Pilot Feedback (F)</a>
                <a id="local-operations" class="panel-secondary-link" href="/local-operations/" title="Local operations dashboard (image-server browser only)">Local operations</a>
            </div>
            <div class="right-stack-controls">
                <div id="series-select-control" class="series-select-control" hidden>
                    <label for="series-select">Select Scan Section / Series</label>
                    <select id="series-select" aria-label="Select Scan Section / Series"></select>
                </div>
                <div id="z-controls-card" class="z-controls-card" hidden>
                <div id="z-depth-controls" class="z-depth-controls" hidden aria-label="Focal depth and animation">
                    <span class="z-depth-controls-label">Z</span>
                    <div class="z-stack-slider-wrap">
                        <input id="z-stack-slider" type="range" min="0" max="0" value="0" step="1"
                               aria-label="Focal Depth (Z)" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
                        <output id="z-stack-value" class="z-stack-control-value" for="z-stack-slider">0</output>
                    </div>
                    <div class="z-movie-icons" role="group" aria-label="Focal animation">
                        <button id="z-movie-mode-loop" class="z-movie-icon is-active z-movie-mode-active" type="button"
                                data-mode="LOOP" title="Head-to-tail loop — click to play"
                                aria-label="Play head-to-tail loop" aria-pressed="true">🔁</button>
                        <button id="z-movie-mode-pingpong" class="z-movie-icon" type="button"
                                data-mode="PING_PONG" title="Ping-pong — click to play"
                                aria-label="Play ping-pong" aria-pressed="false">↔️</button>
                    </div>
                </div>
                </div>
            </div>
        </div>
        <div id="measure-session-panel" class="measure-session-panel" hidden aria-label="Session measurements">
            <h3 class="measure-session-title">Session measurements</h3>
            <ul id="measure-session-list" class="measure-session-list"></ul>
        </div>
        <div class="panel-header">
            <div class="panel-title-row"><h2>Channels</h2><button class="panel-toggle" data-collapse="right" title="Hide display controls" aria-label="Hide display controls">›</button></div>
            <div class="display-actions"><button id="reset" class="action" disabled>Reset display</button><button id="recompute-auto" class="action" disabled>Recompute auto</button></div>
        </div>
        <div id="channels"></div>
        <div id="ai-labs-panel" class="ai-labs-panel">
        <details id="ai-analytics-panel" class="ai-analytics-panel">
            <summary>🔬 Computational Pathology AI Labs</summary>
            <div class="ai-lab-actions">
                <details class="ai-lab-disclaimer">
                    <summary>System Diagnostic Disclaimer</summary>
                    <p class="ai-lab-note">Experimental viewport simulation on this browser only. Results are not diagnostic and are not saved to the annotation store.</p>
                </details>
                <button id="ai-segment-nuclei" class="action" type="button">1. Segment Nuclei</button>
                <div class="ai-plugin-row">
                    <select id="plugin-selector" aria-label="Plugin action">
                        <option value="quantify-nuclei-pixel">Run Pixel Intensity Plugin</option>
                        <option value="per-object-pixel-quantifier">Quantify Individual Objects (Color Code)</option>
                        <option value="ihc-pixel-quantifier">Run IHC Color Deconvolution Plugin</option>
                    </select>
                    <button id="ai-run-plugin" class="action" type="button">Run</button>
                </div>
                <div class="ai-nuclei-row">
                    <button id="ai-nuclei-visible" class="action" type="button" aria-pressed="false" title="Show" aria-label="Show">Show</button>
                    <label class="ai-lab-field" for="ai-seg-target" style="margin:0;flex:1;">
                        <select id="ai-seg-target" aria-label="Segmentation target">
                            <option value="viewport" selected>Visible region</option>
                            <option value="annotation">Selected annotation</option>
                        </select>
                    </label>
                </div>
                <div id="ai-plugin-stats" class="ai-plugin-stats" hidden></div>
                <button id="ai-extract-br-features" class="action" type="button">2. Extract Breast Tissue Features (BR)</button>
                <div id="ai-status-stack" class="ai-status-stack">
                    <div id="ai-lab-config" class="ai-lab-config">
                        <div class="ai-lab-field">
                            <label for="ai-seg-channel">Segmentation Channel</label>
                            <select id="ai-seg-channel">
                                <option value="default" selected>Default Viewport</option>
                                <option value="1">Channel 1 (DAPI/Blue)</option>
                                <option value="2">Channel 2 (Green)</option>
                                <option value="3">Channel 3 (Red)</option>
                            </select>
                        </div>
                        <div class="ai-lab-field">
                            <label for="ai-prob-threshold">Detection Probability Threshold</label>
                            <div class="ai-lab-slider-row">
                                <input id="ai-prob-threshold" type="range" min="0.1" max="1.0" step="0.05" value="0.5">
                                <output id="ai-prob-threshold-value" for="ai-prob-threshold">0.50</output>
                            </div>
                        </div>
                        <div class="ai-lab-field">
                            <label for="ai-nms-threshold">Overlap Suppression / NMS</label>
                            <div class="ai-lab-slider-row">
                                <input id="ai-nms-threshold" type="range" min="0.1" max="1.0" step="0.05" value="0.4">
                                <output id="ai-nms-threshold-value" for="ai-nms-threshold">0.40</output>
                            </div>
                        </div>
                    </div>
                    <div id="ai-status-output" style="color: #ffcc00; font-family: monospace; font-size: 0.85rem; margin-top: 5px;">AI Pipeline: Idle</div>
                    <div style="margin-top: 10px; display: flex; gap: 5px;">
                        <button id="ai-reset-baseline-btn" style="font-size: 0.8rem; background-color: #445566; color: #ffffff; border: 1px solid #667788; padding: 4px 8px; cursor: pointer; border-radius: 3px;">↺ Reset to Auto-Tuned Baseline</button>
                    </div>
                </div>
            </div>
        </details>
        </div>
        <details id="workstation-admin-tools" class="workstation-admin-tools">
            <summary>Workstation Admin Tools</summary>
            <div class="workstation-admin-body">
                <div class="panel-kicker">Browse</div>
                <div class="workstation-admin-title">Sample images</div>
                <div id="directory" class="muted"></div>
                <div class="discovery-controls">
                    <button id="refresh-images" class="action" type="button">Refresh images</button>
                    <span id="discovery-status" class="discovery-status" role="status" aria-live="polite"></span>
                </div>
            </div>
        </details>
    </aside>
    `,
    mount(workspace) {
        const host = workspace || (typeof document !== "undefined" ? document.querySelector(".workspace") : null);
        if (!host || typeof host.insertAdjacentHTML !== "function") return null;
        if (typeof document !== "undefined" && !document.getElementById("legacy-right-panel-style")) {
            const style = document.createElement("style");
            style.id = "legacy-right-panel-style";
            style.textContent = LegacyRightPanelLayout.css;
            document.head.appendChild(style);
        }
        host.insertAdjacentHTML("beforeend", LegacyRightPanelLayout.html);
        return host.querySelector("#channels-panel");
    }
};

if (typeof window !== "undefined") {
    window.LegacyRightPanelLayout = LegacyRightPanelLayout;
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { LegacyRightPanelLayout };
}
