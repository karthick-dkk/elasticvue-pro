ElasticVue Pro 2.1.0 - portable build for Windows x64
=======================================================

Nothing to install, no admin rights, nothing written outside this folder.

Folder layout
  elasticvue-pro.exe       the app
  WebView2Loader.dll       keep next to the exe
  portable                 marker file: keeps all app data in .\data\ (delete it to use %APPDATA% instead)
  data\                    created on first run: pins.json (trusted certs / host keys), WebView profile
  WebView2Runtime\         see below - the only piece Microsoft does not let us ship in this zip
  clusters.example.yaml    copy to clusters.yaml and edit

WebView2Runtime (one-time, no install)
  The app renders its UI with Microsoft WebView2. Windows 10/11 and Server 2019+ already have
  it system-wide and this folder can stay empty. Windows Server 2016 does not, and installing
  the "Evergreen" runtime needs admin - so use Microsoft's FIXED VERSION runtime instead, which
  is just a folder you unpack:
    1. https://developer.microsoft.com/microsoft-edge/webview2/  ->  "Fixed Version"  ->  x64
       (a ~180 MB .cab file, e.g. Microsoft.WebView2.FixedVersionRuntime.140.0.3485.54.x64.cab)
    2. In this folder:   expand Microsoft.WebView2.FixedVersionRuntime.*.x64.cab -F:* WebView2Runtime
       (or 7-Zip -> extract into WebView2Runtime). Result: WebView2Runtime\Microsoft.WebView2...\msedgewebview2.exe
    3. Done. The app finds msedgewebview2.exe there (one level of nesting is fine) and never
       touches the system. ~500 MB on disk; the same folder can be copied to every machine.

Run
  Double-click elasticvue-pro.exe. It is not code-signed: if SmartScreen says
  "Windows protected your PC", choose More info -> Run anyway (once per machine).
  First screen: "Save example..." writes clusters.yaml; edit it (credential, jump_hosts with
  your SSH key file, clusters with via:), then "Open clusters.yaml...". Confirm each jump
  host's key fingerprint once and trust each self-signed certificate once; both go to
  data\pins.json (fingerprints only).

Optional
  elasticvue-pro.exe --config C:\esfleet\clusters.yaml    pre-provisioned config (jump server)
  Tick "Remember on this machine" in the sign-in dialog to keep the credential in the
  Windows Credential Manager (your account only) - the only thing that can leave this folder.

Read-only: the app only sends GET/HEAD and _search-family POSTs to Elasticsearch unless
clusters.yaml sets readOnly: false.
