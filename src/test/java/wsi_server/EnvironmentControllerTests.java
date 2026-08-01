package wsi_server;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

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
    void unknownValueSafelyUsesProduction() {
        assertThat(new EnvironmentController("<script>unexpected</script>").environment())
                .isEqualTo("production");
    }
}
