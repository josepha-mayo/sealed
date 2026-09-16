import json, subprocess, os, sys
args = json.load(open("artifacts/validator-args.json"))
f = open(os.path.expanduser("~/validator.log"), "w")
subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
