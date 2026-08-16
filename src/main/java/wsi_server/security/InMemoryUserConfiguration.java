package wsi_server.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.crypto.password.PasswordEncoder;

/** Local authentication provider; replace this configuration when LDAP is introduced. */
@Configuration
public class InMemoryUserConfiguration {

    private static final Logger log = LoggerFactory.getLogger(InMemoryUserConfiguration.class);

    static final String ANNOTATOR_USERNAME = "Annotator";

    @Bean
    UserDetailsService userDetailsService(
            PasswordEncoder passwordEncoder,
            @Value("${wsi.security.viewer-password}") String viewerPassword,
            @Value("${wsi.security.annotator-password}") String annotatorPassword
    ) {
        InMemoryUserDetailsManager users = new InMemoryUserDetailsManager(
                User.withUsername("viewer")
                        .password(passwordEncoder.encode(viewerPassword))
                        .roles("VIEWER")
                        .build(),
                User.withUsername(ANNOTATOR_USERNAME)
                        .password(passwordEncoder.encode(annotatorPassword))
                        .roles("ANNOTATOR")
                        .build()
        );
        log.info(
                "Login profiles registered in-memory (BCrypt): viewer/ROLE_VIEWER, {}/ROLE_ANNOTATOR",
                ANNOTATOR_USERNAME
        );
        return users;
    }

    @EventListener(ApplicationReadyEvent.class)
    void confirmLoginProfilesReady() {
        log.info(
                "Workstation server fully running; login database profiles initialized: viewer, {}",
                ANNOTATOR_USERNAME
        );
    }
}
