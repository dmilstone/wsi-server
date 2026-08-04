package wsi_server.api;

public record ImageDiscoveryStatus(boolean running, int added, int unavailableOrPending,
                                   String failureCategory, long refreshIntervalMillis) {
}
