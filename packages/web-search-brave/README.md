# Brave Web Search provider

`@dsh-companion/web-search-brave` contributes provider id `brave` to the published `@deepseek-ai/dsh-web` registry. The parent profile must load this package and select `brave`; this package does not change profile configuration.

Store `BRAVE_SEARCH_API_KEY` through the DSH credentials service or export it in the launching environment. Each search resolves the current stored credential first, then the launch environment. No literal key or endpoint override is accepted. Credentials are sent only to the official HTTPS Brave Web Search endpoint with redirects disabled. No secret is logged.

The provider requests web results only (`result_filter=web`, `safesearch=moderate`, count 1–20) and maps URL, title, description and ISO-8601 `page_age` timestamps into DSH sources. It does not generate an answer. It caps the response body at 2 MiB and accepts up to 20 results. Missing credentials produce `WEB_PROVIDER_CREDENTIAL_MISSING`; HTTP, malformed responses and oversized bodies produce `WEB_PROVIDER_ERROR`; cancellation produces `WEB_ABORTED`.

## Model Experience

A search returns source metadata and excerpts, never generated content. The model may consume these results in the usual DSH web-search tool output. This adapter does not add model requests, tokens, or KV-cache entries.

## Known Limitations and Deferred Work

Relative `age` and non-ISO `page_age` values are omitted rather than inventing a publication timestamp. The endpoint is fixed to protect the credential; local HTTP integration tests mock `fetch` instead of redirecting a real API request.
