# Previous releases

The portable Windows build that shipped with each earlier version, kept so a cluster can be
rolled back to a binary that is known to have worked.

| Build | Version | Superseded by | Notes |
|---|---|---|---|
| `elasticvue-pro-2.1.0.exe` | 2.1.0 | 2.2.0 | First build with the UI config editor and encrypted secrets. Predates the operator actions (snapshot / index management), the Alerts page and the config-reload fix — see [CHANGELOG](../CHANGELOG.md). |

## Using one

Each of these is a complete portable app, exactly as `elasticvue-pro-<version>.exe` at the
repo root is. To run an older build, copy it next to `WebView2Loader.dll` (the one at the
repo root — it is Microsoft's loader and is not versioned by this project), keep the
`portable` marker file and `data\` folder alongside, and run it.

`SHA256SUMS.txt` in the repo root covers the **current** build only. The checksums of the
archived ones are here:

    b55d521c1a9f8d4aeaf6fba39ddc73ee8a7519e96dac13a32dbd2d1f80c20b9b  elasticvue-pro-2.1.0.exe

## A caution about config files

A newer build may write a `config_cluster.json` an older one does not fully understand.
Keep a copy of the config before rolling back.
