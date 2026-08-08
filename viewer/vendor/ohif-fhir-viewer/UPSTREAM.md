# OHIF FHIR Viewer Data Source

Source: `https://github.com/node-on-fhir/ohif-fhir-viewer`

Pinned commit: `0935326fcc1eac519929734b061b5a6d645409b1`

Imported on: 2026-08-08

RadSysX vendors only the upstream FHIR R4 and SMART on FHIR data-source files. The
upstream ECG viewport, FHIRcast panel, developer tools, ZIP export, and layout are
not included because RadSysX already owns its OHIF mode and panels.

Local adaptations remove identifier-bearing diagnostic/query logs, reject patient
context and hidden preferences overrides from browser parameters/storage, encode
FHIR resource identifiers, and use the standard `launch openid fhirUser
patient/*.read` SMART scope. Browser-side DICOM writeback and dynamic SMART client
registration are disabled. The adapter and bundle wiring live outside this
directory in `viewer/assets` and `viewer/scripts`.

License: MIT. See `LICENSE`.
