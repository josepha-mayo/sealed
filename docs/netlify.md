# Netlify short URL and canonical verification host

Package with `python3 scripts/netlify-package.py /tmp/sealed-netlify.zip`.
Upload that zip to the existing sealed-eval project. Only public web assets
and response/routing configuration are included.

The short Netlify URL opens the identical verifier release on GitHub Pages.
Netlify continues serving the data assets; root, index and capsule navigation
redirect to GitHub Pages. The forced redirect rules are in
`deploy/netlify-redirects`. `_redirects` and `_headers` are platform
configuration, outside the public evidence asset manifest.

Why: actual Brave navigation and its hash check caught a Netlify hosting
comment inserted into HTML. Turning the badge off and requesting
no-transform removed visible branding and worked for some script requests,
but did not reliably remove the comment from actual browser responses.
Script-only validation therefore was insufficient. The verifier stayed
fail-closed: no comment stripping, normalization, hash exception or changed
trust claim was added. GitHub Pages serves the source bytes unchanged.

The release root and protocol are identical on both deployments. The short
link is retained in Colosseum, while the browser opens the canonical Pages
copy. The devnet memo timestamps the bundle bytes and does not prove fresh
MPC execution.
