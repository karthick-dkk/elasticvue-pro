#!/usr/bin/env python3
"""Set Zabbix 7.0 up for the ElasticVue Pro Clients page and its report widgets.

  ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=… python3 import.py
  ZABBIX_URL=… ZABBIX_USER=Admin ZABBIX_PASSWORD=… python3 import.py [--insecure]

It checks the templates the clients' hosts are linked to (a missing one is named, not worked
around: import it first), creates the host groups that are missing, enables the Clients page
and the widget modules, and creates the widgets' dashboards ("ElasticVue Pro — Client
capacity", "— Client resources") when they do not exist yet. An existing dashboard is never
changed: widgets people added there stay.

The master template itself is not imported here. It follows the roles set on the Clients page,
so the page writes it: ElasticVue Pro → Clients → "Write master template" (and again, by
itself, whenever a role changes).
"""
import json, os, ssl, sys, urllib.request

url = os.environ.get("ZABBIX_URL", "").rstrip("/")
if not url: sys.exit("set ZABBIX_URL (and ZABBIX_TOKEN, or ZABBIX_USER + ZABBIX_PASSWORD)")
ctx = ssl._create_unverified_context() if "--insecure" in sys.argv else None
auth = os.environ.get("ZABBIX_TOKEN")

def call(method, params):
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    req = urllib.request.Request(url + "/api_jsonrpc.php", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(), h)
    r = json.load(urllib.request.urlopen(req, context=ctx))
    if "error" in r: sys.exit(f"{method}: {r['error'].get('data')}")
    return r["result"]

if not auth:
    auth = call("user.login", {"username": os.environ["ZABBIX_USER"], "password": os.environ["ZABBIX_PASSWORD"]})

NEEDS_TEMPLATES = ["Elasticsearch Cluster by HTTP SISA", "Linux by Zabbix agent -SISA", "ElasticVue Pro client plan",
                   "ElasticVue Pro alerts", "ElasticVue Pro log delay", "ElasticVue Pro log archive S3"]
# The groups discovered hosts are linked to, and the one master hosts go in.
NEEDS_GROUPS = ["Elasticsearch clusters", "Log archive", "ESNodes", "Parsers", "Forwarders", "Engines", "ElasticVue clients"]

have = {t["host"] for t in call("template.get", {"filter": {"host": NEEDS_TEMPLATES}, "output": ["host"]})}
missing = [t for t in NEEDS_TEMPLATES if t not in have]
if missing:
    sys.exit("import these templates first: " + ", ".join(missing))

groups = {g["name"] for g in call("hostgroup.get", {"filter": {"name": NEEDS_GROUPS}, "output": ["name"]})}
for g in NEEDS_GROUPS:
    if g not in groups:
        call("hostgroup.create", {"name": g})
        print("created host group", g)

t = call("template.get", {"filter": {"host": "ElasticVue Pro client master"}, "output": ["templateid"], "selectHosts": ["host"]})
print("master template:", ("written; master hosts: " + (", ".join(h["host"] for h in t[0]["hosts"]) or "none yet")) if t
      else "not written yet — ElasticVue Pro → Clients → Write master template")

# The cross-client tables. Their modules have to be in Zabbix's modules directory already
# (see ../capacity-widget/README.md); registering and enabling them is what "Scan directory"
# and the Enable link would do.
def soft(method, params):
    h = {"Content-Type": "application/json-rpc", "Authorization": "Bearer " + auth}
    req = urllib.request.Request(url + "/api_jsonrpc.php", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(), h)
    return json.load(urllib.request.urlopen(req, context=ctx))

# The Clients page (ElasticVue Pro → Clients): a module with no dashboard of its own.
clients = call("module.get", {"filter": {"id": "evp_clients"}, "output": ["moduleid", "status"]})
if not clients:
    r = soft("module.create", {"id": "evp_clients", "relative_path": "modules/evp_clients", "status": 1})
    print("evp_clients:", "not in Zabbix's modules directory — " + str(r["error"].get("data")) if "error" in r else "registered and enabled")
elif clients[0]["status"] != "1":
    call("module.update", {"moduleid": clients[0]["moduleid"], "status": 1})
    print("evp_clients: enabled")

WIDGETS = [("evp_capacity", "ElasticVue Pro — Client capacity", "Client capacity"),
           ("evp_resources", "ElasticVue Pro — Client resources", "Client resources")]
gid = call("hostgroup.get", {"filter": {"name": "ElasticVue clients"}, "output": ["groupid"]})[0]["groupid"]
for module_id, dashboard, widget in WIDGETS:
    modules = call("module.get", {"filter": {"id": module_id}, "output": ["moduleid", "status"]})
    if not modules:
        r = soft("module.create", {"id": module_id, "relative_path": f"modules/{module_id}", "status": 1})
        if "error" in r:
            print(f"{module_id}: not in Zabbix's modules directory — {dashboard} not created:", r["error"].get("data"))
            continue
        print(f"{module_id}: registered and enabled")
    elif modules[0]["status"] != "1":
        call("module.update", {"moduleid": modules[0]["moduleid"], "status": 1})
        print(f"{module_id}: enabled")
    # Created once. After that it is the users' dashboard: widgets added, moved or resized
    # there are kept — an import never deletes or rebuilds it.
    if call("dashboard.get", {"filter": {"name": dashboard}, "output": ["dashboardid"]}):
        print("dashboard kept as it is:", dashboard)
        continue
    did = call("dashboard.create", {"name": dashboard, "display_period": 60, "auto_start": 0, "pages": [{"widgets": [{
        "type": module_id, "name": widget, "x": 0, "y": 0, "width": 72, "height": 10, "view_mode": 0,
        "fields": [{"type": 2, "name": "groupids.0", "value": gid}]}]}]})["dashboardids"][0]
    print("dashboard", did, "created:", dashboard)
