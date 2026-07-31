(function (global) {
    "use strict";

    const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

    function cookieValue(name) {
        const prefix = `${encodeURIComponent(name)}=`;
        const cookie = document.cookie.split(";").map(part => part.trim())
            .find(part => part.startsWith(prefix));
        return cookie ? decodeURIComponent(cookie.substring(prefix.length)) : null;
    }

    function withCsrf(options = {}) {
        const method = (options.method || "GET").toUpperCase();
        if (!UNSAFE_METHODS.has(method)) return options;

        const token = cookieValue("XSRF-TOKEN");
        if (!token) return options;

        const headers = new Headers(options.headers || {});
        headers.set("X-XSRF-TOKEN", token);
        return {...options, headers};
    }

    global.WsiCsrf = {withCsrf};
})(window);
