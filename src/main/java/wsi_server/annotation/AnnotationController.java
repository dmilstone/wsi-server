package wsi_server.annotation;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

@RestController
@RequestMapping("/api/images/{imageId}/annotations")
public class AnnotationController {
    private final AnnotationService annotationService;
    private final AnnotationUserResolver userResolver;

    public AnnotationController(AnnotationService annotationService, AnnotationUserResolver userResolver) {
        this.annotationService = annotationService;
        this.userResolver = userResolver;
    }

    @GetMapping
    public AnnotationCollection load(@PathVariable String imageId, HttpServletRequest request) throws IOException {
        return annotationService.load(imageId, userResolver.resolve(request));
    }

    @PutMapping
    public AnnotationCollection save(
            @PathVariable String imageId,
            @RequestBody AnnotationCollection collection,
            HttpServletRequest request
    ) throws IOException {
        return annotationService.save(imageId, userResolver.resolve(request), collection);
    }
}
