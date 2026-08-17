package wsi_server;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WorkstationWebConfiguration implements WebMvcConfigurer {

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/local-operations/**")
                .addResourceLocations("classpath:/static/local-operations/");
        registry.addResourceHandler("/help/**")
                .addResourceLocations("classpath:/static/help/");
        registry.addResourceHandler("/pilot-feedback/**")
                .addResourceLocations("classpath:/static/pilot-feedback/");
    }
}
