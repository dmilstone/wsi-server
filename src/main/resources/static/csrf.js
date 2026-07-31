(function (global) {
    "use strict";

    const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    let csrfToken = null;
    let csrfHeaderName = null;
    let tokenRequest = null;

    async function acquireToken(forceRefresh = false) {
        if (!forceRefresh && csrfToken && csrfHeaderName) return;
        if (tokenRequest) return tokenRequest;

        if (forceRefresh) {
            csrfToken = null;
            csrfHeaderName = null;
        }

        tokenRequest = (async () => {
            const response = await fetch("/csrf");
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `${response.status} ${response.statusText}`);
            }
            const csrf = await response.json();
            csrfHeaderName = csrf.headerName;
            csrfToken = cookieValue("XSRF-TOKEN");
            if (!csrfHeaderName) throw new Error("Invalid CSRF token response: headerName is absent");
            if (!csrfToken) throw new Error("CSRF token acquisition failed: XSRF-TOKEN cookie is absent");
        })().finally(() => {
            tokenRequest = null;
        });
        return tokenRequest;
    }

    async function csrfFetch(url, options = {}) {
        const method = (options.method || "GET").toUpperCase();
        if (!UNSAFE_METHODS.has(method)) return fetch(url, options);

        await acquireToken();
        let response = await fetchWithToken(url, options);
        if (response.status === 403) {
            await acquireToken(true);
            response = await fetchWithToken(url, options);
        }
        return response;
    }

    function fetchWithToken(url, options) {
        const headers = new Headers(options.headers || {});
        headers.set(csrfHeaderName, csrfToken);
        return fetch(url, {...options, headers});
    }

    function cookieValue(name) {
        const prefix = `${encodeURIComponent(name)}=`;
        const cookie = document.cookie.split(";").map(part => part.trim())
            .find(part => part.startsWith(prefix));
        return cookie ? decodeURIComponent(cookie.substring(prefix.length)) : null;
    }

    global.WsiCsrf = {initialize: acquireToken, csrfFetch};
})(window);
