package wsi_server.plugin;

/**
 * Lightweight proof-of-principle plugin contract. Implementations are Spring
 * components discovered by {@link PluginRegistry}.
 */
public interface WsiPlugin {

    String id();

    String title();

    PluginResult execute(PluginExecuteRequest request) throws Exception;
}
