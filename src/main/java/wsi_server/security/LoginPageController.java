package wsi_server.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import java.util.function.Supplier;

/**
 * Serves GET {@code /login}. Setting {@code formLogin().loginPage("/login")}
 * disables Spring Security's generated page; without this mapping, /login 404s
 * and /error bounces back into /login (ERR_TOO_MANY_REDIRECTS).
 */
@Controller
class LoginPageController {

    @GetMapping("/login")
    @ResponseBody
    String login(HttpServletRequest request) {
        CsrfToken csrf = resolveCsrf(request);
        String parameter = csrf != null ? escape(csrf.getParameterName()) : "_csrf";
        String token = csrf != null ? escape(csrf.getToken()) : "";
        boolean failed = request.getParameter("error") != null;
        boolean loggedOut = request.getParameter("logout") != null;
        String notice = failed ? "<p>Invalid username or password.</p>"
                : loggedOut ? "<p>Signed out.</p>" : "";
        return """
                <!DOCTYPE html>
                <html lang="en">
                <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>Sign in</title>
                  <link rel="stylesheet" href="/default-ui.css">
                </head>
                <body>
                  <div class="container">
                    <form class="login-form" method="post" action="/login">
                      <h2>Please sign in</h2>
                      %s
                      <p>
                        <label for="username">Username</label>
                        <input type="text" id="username" name="username" autofocus>
                      </p>
                      <p>
                        <label for="password">Password</label>
                        <input type="password" id="password" name="password">
                      </p>
                      <input type="hidden" name="%s" value="%s">
                      <button type="submit">Sign in</button>
                    </form>
                  </div>
                </body>
                </html>
                """.formatted(notice, parameter, token);
    }

    private static CsrfToken resolveCsrf(HttpServletRequest request) {
        Object value = request.getAttribute(CsrfToken.class.getName());
        if (value instanceof Supplier<?> supplier) {
            value = supplier.get();
        }
        return value instanceof CsrfToken csrf ? csrf : null;
    }

    private static String escape(String value) {
        if (value == null) return "";
        return value.replace("&", "&amp;")
                .replace("\"", "&quot;")
                .replace("<", "&lt;");
    }
}
