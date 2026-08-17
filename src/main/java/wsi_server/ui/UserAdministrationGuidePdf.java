package wsi_server.ui;

import java.util.ArrayList;
import java.util.List;

final class UserAdministrationGuidePdf {

    private UserAdministrationGuidePdf() {
    }

    static byte[] render() {
        List<String> lines = new ArrayList<>();
        lines.add(UserAdministrationGuideContent.SUBTITLE);
        lines.add("");
        for (UserAdministrationGuideContent.Section section : UserAdministrationGuideContent.sections()) {
            lines.add(section.heading());
            if (section.intro() != null && !section.intro().isBlank()) {
                lines.add(section.intro());
            }
            for (UserAdministrationGuideContent.Bullet bullet : section.bullets()) {
                lines.add("  - " + bullet.label() + ": " + bullet.body());
            }
            if (section.protocolHeading() != null && !section.protocolSteps().isEmpty()) {
                lines.add(section.protocolHeading());
                int step = 1;
                for (String protocolStep : section.protocolSteps()) {
                    lines.add("  " + step + ". " + protocolStep);
                    step += 1;
                }
            }
            lines.add("");
        }
        lines.add("LEGAL DISCLAIMER");
        lines.add(UserAdministrationGuideContent.LEGAL_DISCLAIMER);
        return SimpleTextPdfWriter.write(UserAdministrationGuideContent.TITLE, lines);
    }
}
