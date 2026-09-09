(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.WsiEnvironment = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONFIGURATION = Object.freeze({
        production: Object.freeze({banner: "", titlePrefix: ""}),
        staging: Object.freeze({banner: "STAGING — VALIDATION ONLY", titlePrefix: "[STAGING]"}),
        development: Object.freeze({banner: "DEVELOPMENT — NOT FOR CLINICAL USE", titlePrefix: "[DEV]"})
    });

    function configurationFor(environment) {
        return CONFIGURATION[environment] || CONFIGURATION.production;
    }

    function apply(environment, documentObject) {
        const configuration = configurationFor(environment);
        const banner = documentObject.getElementById("environment-banner");
        banner.textContent = configuration.banner;
        banner.hidden = !configuration.banner;
        documentObject.body.classList.toggle("nonproduction-environment", Boolean(configuration.banner));
        const titleNode = (typeof documentObject.getElementById === "function"
                ? documentObject.getElementById("wsi-document-title")
                : null)
            || documentObject.querySelector("head > title")
            || documentObject.querySelector("title");
        const normalTitle = String(titleNode?.dataset?.normalTitle || "WSI Viewer").trim() || "WSI Viewer";
        if (titleNode?.dataset) titleNode.dataset.titlePrefix = configuration.titlePrefix || "";
        const nextTitle = configuration.titlePrefix
            ? `${configuration.titlePrefix} ${normalTitle}`
            : normalTitle;
        documentObject.title = nextTitle;
        if (titleNode) titleNode.textContent = nextTitle;
        return configuration;
    }

    async function initialize(documentObject, fetchFunction) {
        let environment = "production";
        try {
            const response = await fetchFunction("/api/environment", {headers: {Accept: "text/plain"}});
            if (response.ok) environment = (await response.text()).trim();
        } catch (_) {
            // A failed identifier request must never create a nonproduction label.
        }
        apply(environment, documentObject);
        return environment;
    }

    return Object.freeze({configurationFor, apply, initialize});
}));
