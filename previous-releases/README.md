# Previous releases

The portable Windows build that shipped with each earlier version, kept so a cluster can be
rolled back to a binary that is known to have worked.

| Build | Version | Superseded by | Notes |
|---|---|---|---|
| `elasticvue-pro-2.1.0.exe` | 2.1.0 | 2.2.2 | First build with the UI config editor and encrypted secrets. Predates the operator actions (snapshot / index management), the Alerts page and the config-reload fix — see [CHANGELOG](../CHANGELOG.md). |
| `elasticvue-pro-2.2.0.exe` | 2.2.0 | 2.2.1 | Never tagged or released. Functionally the same as 2.2.1 on Windows; superseded because its Linux build could not compile. Kept only for completeness. |
| `elasticvue-pro-2.2.1.exe` | 2.2.1 | 2.2.2 | First tagged multi-platform release. Predates the ⋮ action menus and named confirmations, the Volume report, alert acknowledgements and the client/source rename — see [CHANGELOG](../CHANGELOG.md). |

## Using one

Each of these is a complete portable app, exactly as `elasticvue-pro-<version>.exe` at the
repo root is. To run an older build, copy it next to `WebView2Loader.dll` (the one at the
repo root — it is Microsoft's loader and is not versioned by this project), keep the
`portable` marker file and `data\` folder alongside, and run it.

`SHA256SUMS.txt` in the repo root covers the **current** build only. The checksums of the
archived ones are here:

    b55d521c1a9f8d4aeaf6fba39ddc73ee8a7519e96dac13a32dbd2d1f80c20b9b  elasticvue-pro-2.1.0.exe
    c71c944f9cc2b8fe6437f2e289ea19d0f0d1361a461772a02e2e4a7248be0f7f  elasticvue-pro-2.2.0.exe
    8f044e264d9da99013935baa36d88c69c3173a7739be8ed843493191dc4d00c3  elasticvue-pro-2.2.1.exe

## A caution about config files

A newer build may write a `config_cluster.json` an older one does not fully understand.
Keep a copy of the config before rolling back.
