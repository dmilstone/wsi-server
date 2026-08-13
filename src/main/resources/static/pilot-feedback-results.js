(function (global) {
    "use strict";

    const REFRESH_MS = 4000;
    const TASK_COLORS = {
        COMPLETED_EASILY: "easy",
        COMPLETED_WITH_DIFFICULTY: "difficult",
        COULD_NOT_COMPLETE: "could-not",
        DID_NOT_TRY: "did-not-try"
    };

    const RATING_LABELS = {
        image_navigation: "Image navigation",
        image_switching: "Image switching",
        responsiveness: "Responsiveness",
        channel_display_controls: "Channel/display controls",
        annotation_workflow: "Annotation workflow",
        toolbar_clarity: "Toolbar clarity",
        export_workflow: "Export workflow",
        overall_ease: "Overall ease of use",
        confidence_without_assistance: "Confidence without assistance"
    };

    let viewMode = "all";
    let refreshTimer = null;
    let inFlight = false;

    function setViewMode(mode) {
        viewMode = mode;
        document.getElementById("view-all").setAttribute("aria-pressed", String(mode === "all"));
        document.getElementById("view-dedup").setAttribute("aria-pressed", String(mode === "deduplicated"));
        updateExportLinks();
        refreshSummary();
    }

    function updateExportLinks() {
        const dedup = viewMode === "deduplicated" ? "true" : "false";
        document.getElementById("export-json").href = `/api/pilot-feedback/export.json?deduplicated=${dedup}`;
        document.getElementById("export-csv").href = `/api/pilot-feedback/export.csv?deduplicated=${dedup}`;
    }

    function renderSummaryCards(summary) {
        const cards = [
            ["Total submissions", summary.totalSubmissions],
            ["Unique usernames", summary.uniqueUsernames],
            ["Unique browser IDs", summary.uniqueDeviceIds],
            ["Unique username+device", summary.uniqueCombos],
            ["Repeat submissions", summary.repeatSubmissions],
            ["Latest submission", summary.latestSubmissionAt ? formatTimestamp(summary.latestSubmissionAt) : "—"]
        ];
        document.getElementById("summary-cards").innerHTML = cards.map(([label, value]) => `
            <div class="pilot-summary-card"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>
        `).join("");
    }

    function renderTaskCharts(taskStats) {
        const blocks = taskStats.map(task => {
            const total = Object.values(task.counts).reduce((sum, count) => sum + count, 0) || 1;
            const segments = Object.entries(task.counts).map(([key, count]) => {
                const width = (count / total) * 100;
                return `<span class="pilot-bar-segment ${TASK_COLORS[key] || ""}" style="width:${width}%" title="${labelForTask(key)}: ${count}"></span>`;
            }).join("");
            const legend = Object.entries(task.counts).map(([key, count]) => `${labelForTask(key)} ${count}`).join(" · ");
            return `
                <div class="pilot-bar-row">
                    <span>${escapeHtml(task.label)}</span>
                    <div class="pilot-bar-track" aria-label="${escapeHtml(task.label)} completion">${segments}</div>
                    <span>${escapeHtml(legend)}</span>
                </div>`;
        }).join("");
        document.getElementById("task-charts").innerHTML = `
            <h3>Task completion</h3>
            <div class="pilot-bar-chart">${blocks}</div>`;
    }

    function renderRatingCharts(ratings) {
        const blocks = Object.entries(ratings).map(([id, stats]) => {
            const max = Math.max(...Object.values(stats.distribution), 1);
            const bars = Object.entries(stats.distribution).map(([score, count]) => {
                const width = (count / max) * 100;
                return `
                    <div class="pilot-bar-row">
                        <span>${score}</span>
                        <div class="pilot-bar-track"><span class="pilot-rating-bar" style="width:${width}%"></span></div>
                        <span>${count}</span>
                    </div>`;
            }).join("");
            return `
                <div class="pilot-chart-block">
                    <h3>${escapeHtml(RATING_LABELS[id] || id)}</h3>
                    <p class="pilot-muted">n=${stats.count}, mean=${stats.mean}, median=${stats.median}</p>
                    <div class="pilot-bar-chart">${bars}</div>
                </div>`;
        }).join("");
        document.getElementById("rating-charts").innerHTML = `<h3>Ratings</h3>${blocks}`;
    }

    function renderResponderTable(rows) {
        document.getElementById("responder-table").innerHTML = `
            <h3>Responders</h3>
            <div class="pilot-table-wrap">
                <table class="pilot-table">
                    <thead><tr><th>User</th><th>Device</th><th>Submissions</th><th>Latest</th></tr></thead>
                    <tbody>${rows.map(row => `
                        <tr>
                            <td>${escapeHtml(row.authenticatedUserId)}</td>
                            <td>${escapeHtml(row.deviceIdShort)}</td>
                            <td>${row.submissionCount}</td>
                            <td>${escapeHtml(formatTimestamp(row.latestSubmittedAt))}</td>
                        </tr>`).join("")}</tbody>
                </table>
            </div>`;
    }

    function renderFreeText(entries) {
        if (!entries.length) {
            document.getElementById("free-text").innerHTML = `<h3>Free-text comments</h3><p class="pilot-muted">No comments yet.</p>`;
            return;
        }
        document.getElementById("free-text").innerHTML = `
            <h3>Free-text comments</h3>
            <div class="pilot-free-text-list">${entries.map(entry => `
                <article class="pilot-free-text-item">
                    <h4>${escapeHtml(entry.authenticatedUserId)} · ${escapeHtml(entry.deviceIdShort)} · ${escapeHtml(formatTimestamp(entry.submittedAt))}</h4>
                    ${renderTextBlock("Most useful", entry.mostUseful)}
                    ${renderTextBlock("Most confusing", entry.mostConfusing)}
                    ${renderTextBlock("Expected but missing", entry.expectedMissing)}
                    ${renderTextBlock("Other comments", entry.otherComments)}
                </article>`).join("")}</div>`;
    }

    function renderTextBlock(label, value) {
        if (!value) return "";
        return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
    }

    async function refreshSummary() {
        if (inFlight) return;
        inFlight = true;
        const refreshMeta = document.getElementById("refresh-meta");
        try {
            const response = await fetch(`/api/pilot-feedback/summary?view=${encodeURIComponent(viewMode)}`);
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const summary = await response.json();
            renderSummaryCards(summary);
            renderTaskCharts(summary.taskCompletion || []);
            renderRatingCharts(summary.ratings || {});
            renderResponderTable(summary.responders || []);
            renderFreeText(summary.freeText || []);
            refreshMeta.textContent = `Last refresh: ${new Date().toLocaleString()} · Latest submission: ${summary.latestSubmissionAt ? formatTimestamp(summary.latestSubmissionAt) : "—"} · View: ${summary.viewMode}`;
        } catch (error) {
            refreshMeta.textContent = `Refresh failed: ${error.message}`;
        } finally {
            inFlight = false;
        }
    }

    function labelForTask(key) {
        return ({
            COMPLETED_EASILY: "Completed easily",
            COMPLETED_WITH_DIFFICULTY: "Completed with difficulty",
            COULD_NOT_COMPLETE: "Could not complete",
            DID_NOT_TRY: "Did not try"
        })[key] || key;
    }

    function formatTimestamp(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("\"", "&quot;");
    }

    function initialize() {
        document.getElementById("view-all").addEventListener("click", () => setViewMode("all"));
        document.getElementById("view-dedup").addEventListener("click", () => setViewMode("deduplicated"));
        updateExportLinks();
        refreshSummary();
        refreshTimer = window.setInterval(refreshSummary, REFRESH_MS);
    }

    global.WsiPilotFeedbackResults = {initialize, refreshSummary, setViewMode};
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else {
        initialize();
    }
})(window);
