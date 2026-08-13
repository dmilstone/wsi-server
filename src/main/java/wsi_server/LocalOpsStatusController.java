package wsi_server;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reports whether the loopback ops dashboard is accepting connections on
 * {@code 127.0.0.1:8084}. Does not proxy traffic to that service.
 */
@RestController
public class LocalOpsStatusController {
    public static final String DASHBOARD_URL = "http://127.0.0.1:8084/";
    public static final String BIND_HOST = "127.0.0.1";
    public static final int BIND_PORT = 8084;

    @GetMapping(value = "/api/local-ops/status", produces = MediaType.APPLICATION_JSON_VALUE)
    Map<String, Object> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("listening", isListening());
        body.put("url", DASHBOARD_URL);
        body.put("host", BIND_HOST);
        body.put("port", BIND_PORT);
        return body;
    }

    static boolean isListening() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(BIND_HOST, BIND_PORT), 250);
            return true;
        } catch (IOException ignored) {
            return false;
        }
    }
}
