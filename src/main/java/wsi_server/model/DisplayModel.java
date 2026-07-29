package wsi_server.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Holds display state for every fluorescence channel.
 */
public final class DisplayModel {

    private final List<ChannelDisplaySettings> channels;

    public DisplayModel(
            int channelCount
    ) {
        if (channelCount <= 0) {
            throw new IllegalArgumentException(
                    "Channel count must be positive."
            );
        }

        List<ChannelDisplaySettings> channelSettings =
                new ArrayList<>(channelCount);

        for (int channel = 0; channel < channelCount; channel++) {
            channelSettings.add(
                    new ChannelDisplaySettings()
            );
        }

        this.channels = Collections.unmodifiableList(
                channelSettings
        );
    }

    public int getChannelCount() {
        return channels.size();
    }

    public ChannelDisplaySettings getChannel(
            int channel
    ) {
        if (channel < 0 || channel >= channels.size()) {
            throw new IllegalArgumentException(
                    "Channel must be between 0 and "
                            + (channels.size() - 1)
                            + ". Received: "
                            + channel
            );
        }

        return channels.get(channel);
    }

    public List<ChannelDisplaySettings> getChannels() {
        return channels;
    }
}
