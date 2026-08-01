package wsi_server;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EnvironmentControllerTests {

    @Test
    void returnsProduction() {
        assertThat(new EnvironmentController("production").environment()).isEqualTo("production");
    }

    @Test
    void returnsStaging() {
        assertThat(new EnvironmentController("staging").environment()).isEqualTo("staging");
    }

    @Test
    void returnsDevelopment() {
        assertThat(new EnvironmentController("development").environment()).isEqualTo("development");
    }

    @Test
    void environmentNormalizationIsSharedAndStrict() {
        assertThatThrownBy(() -> new EnvironmentController("<script>unexpected</script>"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expected production, staging, or development");
    }
}
