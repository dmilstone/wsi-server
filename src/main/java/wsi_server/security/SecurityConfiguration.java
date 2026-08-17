package wsi_server.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.ui.DefaultResourcesFilter;

@Configuration
public class SecurityConfiguration {

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(csrf -> csrf.spa())
                .authorizeHttpRequests(authorize -> authorize
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
}
