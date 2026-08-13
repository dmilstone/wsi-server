package wsi_server;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class LocalOpsStatusControllerTests {

    @Test
    void statusPayloadAlwaysNamesLoopbackDashboardEndpoint() {
        Map<String, Object> body = new LocalOpsStatusController().status();
        assertThat(body.get("url")).isEqualTo("http://127.0.0.1:8084/");
        assertThat(body.get("host")).isEqualTo("127.0.0.1");
        assertThat(body.get("port")).isEqualTo(8084);
        assertThat(body.get("listening")).isInstanceOf(Boolean.class);
    }
}
