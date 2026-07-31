package wsi_server;

import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import wsi_server.api.CsrfTokenResponse;

@RestController
public class CsrfController {

    @GetMapping("/csrf")
    CsrfTokenResponse csrf(CsrfToken csrfToken) {
        return CsrfTokenResponse.from(csrfToken);
    }
}
