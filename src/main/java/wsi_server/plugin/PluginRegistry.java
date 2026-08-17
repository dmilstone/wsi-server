package wsi_server.plugin;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Component
public class PluginRegistry {

    private final Map<String, WsiPlugin> plugins;

    public PluginRegistry(List<WsiPlugin> plugins) {
        this.plugins = plugins.stream().collect(Collectors.toMap(
                plugin -> plugin.id().toLowerCase(Locale.ROOT),
                Function.identity(),
                (left, right) -> left
        ));
    }

    public WsiPlugin require(String pluginId) {
        String key = pluginId == null || pluginId.isBlank()
                ? QuantifyNucleiPixelPlugin.ID
                : pluginId.trim().toLowerCase(Locale.ROOT);
        WsiPlugin plugin = plugins.get(key);
        if (plugin == null) {
            throw new IllegalArgumentException("Unknown plugin: " + key);
        }
        return plugin;
    }
}
