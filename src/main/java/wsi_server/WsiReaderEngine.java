package wsi_server;

/**
 * Unified tile/metadata contract for Bio-Formats and OpenSlide backends.
 */
public interface WsiReaderEngine {

    byte[] getTile(int level, int x, int y) throws Exception;

    WsiEngineMetadata getMetadata();
}
