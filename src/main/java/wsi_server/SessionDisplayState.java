package wsi_server;

import wsi_server.model.DisplayModel;

/** Mutable display settings belonging to one HTTP browser session and one image. */
final class SessionDisplayState {
    private DisplayModel model;
    private long revision;

    SessionDisplayState(DisplayModel model) { this.model = model; }
    DisplayModel model() { return model; }
    long revision() { return revision; }
    long incrementRevision() { return ++revision; }
    void reset(DisplayModel replacement) { model = replacement; revision++; }
}
