package wsi_server.model;

/**
 * Color lookup tables available for fluorescence display.
 *
 * Milestone 4 stores this setting but does not yet apply it
 * during rendering.
 */
public enum LutType {
    GRAY,
    GREEN,
    MAGENTA,
    CYAN,
    RED,
    YELLOW
}
