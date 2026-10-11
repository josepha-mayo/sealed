# Netlify byte-preserving deployment

Package with `python3 scripts/netlify-package.py /tmp/sealed-netlify.zip`.
Upload that zip to the existing sealed-eval project. Only public web assets
and the `_headers` deployment configuration are included.

Keep Pretty URLs and Powered by Netlify badge disabled for this project.
`deploy/netlify-headers` sets `no-transform` so edge marketing comments do
not change the manifest-pinned HTML. HTML also uses `no-store` to prevent a
previously transformed response from remaining in a browser cache. Hosting
configuration is outside the web asset manifest because `_headers` is
processed by the platform rather than served as an evidence asset.

Verify with a browser user agent as well as Python. On October 12 the
browser correctly caught an injected comment that a default script request
did not receive. Do not normalize or strip altered HTML to make it pass.
The UI status now inspects actual failed check elements; the text `0 fail`
no longer creates a false warning.
