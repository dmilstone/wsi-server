package wsi_server.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.crypto.password.PasswordEncoder;

/** Local authentication provider; replace this configuration when LDAP is introduced. */
@Configuration
public class InMemoryUserConfiguration {

    @Bean
    UserDetailsService userDetailsService(
            PasswordEncoder passwordEncoder,
            @Value("${wsi.security.viewer-password}") String viewerPassword,
            @Value("${wsi.security.annotator-password}") String annotatorPassword
    ) {
        return new InMemoryUserDetailsManager(
                User.withUsername("viewer")
                        .password(passwordEncoder.encode(viewerPassword))
                        .roles("VIEWER")
                        .build(),
                User.withUsername("annotator")
                        .password(passwordEncoder.encode(annotatorPassword))
                        .roles("ANNOTATOR")
                        .build()
        );
    }
}
