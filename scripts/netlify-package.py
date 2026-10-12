#!/usr/bin/env python3
"""Package public assets plus Netlify response configuration; never include .env."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
p=argparse.ArgumentParser();p.add_argument('output',type=Path);args=p.parse_args()
repo=Path(__file__).resolve().parent.parent
with ZipFile(args.output,'w',ZIP_DEFLATED) as z:
    for f in sorted((repo/'web').rglob('*')):
        if f.is_file(): z.write(f,f.relative_to(repo/'web').as_posix())
    z.write(repo/'deploy/netlify-headers','_headers')
    z.write(repo/'deploy/netlify-redirects','_redirects')
print(args.output)
