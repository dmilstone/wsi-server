# Milestone 13.1 authentication

The viewer and its image and annotation endpoints now require a session created
through Spring Security's form login. Visit `/login` directly, or open a
protected URL to be redirected there. Submit `POST /logout` (including the CSRF
token, as Spring Security's generated pages do) to end the session.

Two local users are available:

| Username | Role | Password configuration |
| --- | --- | --- |
| `viewer` | `VIEWER` | `wsi.security.viewer-password` / `WSI_VIEWER_PASSWORD` |
| `annotator` | `ANNOTATOR` | `wsi.security.annotator-password` / `WSI_ANNOTATOR_PASSWORD` |

Development defaults are declared in `src/main/resources/application.properties`.
Set the environment variables in deployments rather than using those defaults.
The configured password text is BCrypt-hashed when the in-memory users are
created; only the hash is retained by the user-details service.

HTTP security and password encoding are kept in `SecurityConfiguration`, while
the temporary local identity store is isolated in `InMemoryUserConfiguration`.
This allows a future authentication provider to replace the in-memory store
without changing URL security rules.
