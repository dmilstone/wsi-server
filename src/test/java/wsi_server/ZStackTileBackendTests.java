package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ZStackTileBackendTests {

    @Test
    void zPlaneCountDefaultsStandard2dSlidesToOne() {
        assertThat(BioFormatsTileService.zPlaneCount(0)).isEqualTo(1);
        assertThat(BioFormatsTileService.zPlaneCount(1)).isEqualTo(1);
        assertThat(BioFormatsTileService.zPlaneCount(7)).isEqualTo(7);
    }

    @Test
    void tileEndpointForwardsOptionalZAndSeriesQueryToReaderService() throws Exception {
        BioFormatsTileService service = mock(BioFormatsTileService.class);
        when(service.getTile(eq("slide-a"), eq(2), eq(0), eq(3), eq(4), eq(5), eq(2), any(HttpSession.class)))
                .thenReturn(new byte[] {1, 2, 3});
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new TileController(service)).build();

        mvc.perform(get("/tile/slide-a/2/3/4.png").param("z", "5").param("series", "2"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(new byte[] {1, 2, 3}));

        verify(service).getTile(eq("slide-a"), eq(2), eq(0), eq(3), eq(4), eq(5), eq(2), any(HttpSession.class));
    }

    @Test
    void compositeTileEndpointDefaultsZAndSeriesToZeroWhenOmitted() throws Exception {
        BioFormatsTileService service = mock(BioFormatsTileService.class);
        when(service.getCompositeTile(eq("slide-a"), eq(1), eq(0), eq(0), eq(0), eq(0), any(HttpSession.class)))
                .thenReturn(new byte[] {9});
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new TileController(service)).build();

        mvc.perform(get("/tile/slide-a/composite/1/0/0.png"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(new byte[] {9}));

        verify(service).getCompositeTile(eq("slide-a"), eq(1), eq(0), eq(0), eq(0), eq(0), any(HttpSession.class));
    }

    @Test
    void sessionStateKeyIsolatesSeriesDisplayState() {
        assertThat(BioFormatsTileService.sessionStateKey("img", 0)).isEqualTo("img#0");
        assertThat(BioFormatsTileService.sessionStateKey("img", 2)).isEqualTo("img#2");
    }

    @Test
    void validateZRejectsOutOfRangePlanes() {
        assertThatThrownBy(() -> invokeValidateZ(-1, 3))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Z-plane");
        assertThatThrownBy(() -> invokeValidateZ(3, 3))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Z-plane");
    }

    private static void invokeValidateZ(int z, int sizeZ) throws Exception {
        var method = BioFormatsTileService.class.getDeclaredMethod("validateZ", int.class, int.class);
        method.setAccessible(true);
        BioFormatsTileService target = mock(BioFormatsTileService.class);
        try {
            method.invoke(target, z, sizeZ);
        } catch (java.lang.reflect.InvocationTargetException ex) {
            if (ex.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw ex;
        }
    }
}
