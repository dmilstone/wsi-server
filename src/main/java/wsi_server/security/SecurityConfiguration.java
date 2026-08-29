package wsi_server.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.ui.DefaultResourcesFilter;
import org.springframework.security.web.util.matcher.RequestMatcher;

import java.net.InetAddress;

@Configuration
public class SecurityConfiguration {

    /**
     * Local ingest daemon POSTs {@code /api/images/refresh} with no session.
     * Only loopback peers are accepted; remote callers still need login + CSRF.
     */
    static final RequestMatcher LOOPBACK_IMAGE_REFRESH = SecurityConfiguration::isLoopbackImageRefresh;

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(csrf -> csrf.spa().ignoringRequestMatchers(LOOPBACK_IMAGE_REFRESH))
                .authorizeHttpRequests(authorize -> authorize
                        .requestMatchers(LOOPBACK_IMAGE_REFRESH).permitAll()
                        .requestMatchers(
                                "/login",
                                "/login?error",
                                "/login?logout",
                                "/css/**",
                                "/js/**",
                                "/images/**",
                                "/default-ui.css",
                                "/error"
                        ).permitAll()
                        .requestMatchers(
                                "/",
                                "/index.html",
                                "/browse/**",
                                "/metadata/**",
                                "/display/**",
                                "/tile/**",
                                "/thumbnail/**",
                                "/annotations/**"
                        ).authenticated()
                        .anyRequest().authenticated()
                )
                .formLogin(form -> form
                        .loginPage("/login")
                        .defaultSuccessUrl("/?continue", true)
                        .permitAll()
                )
                .logout(logout -> logout
                        .logoutSuccessUrl("/login?logout")
                        .permitAll());
        http.addFilter(DefaultResourcesFilter.css());
        return http.build();
    }

    static boolean isLoopbackImageRefresh(HttpServletRequest request) {
        if (request == null || !"POST".equalsIgnoreCase(request.getMethod())) return false;
        String path = request.getServletPath();
        if (path == null || path.isBlank()) path = request.getRequestURI();
        if (!"/api/images/refresh".equals(path)) return false;
        return isLoopbackAddress(request.getRemoteAddr());
    }

    static boolean isLoopbackAddress(String address) {
        if (address == null || address.isBlank()) return false;
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (Exception ignored) {
            return false;
        }
    }
}
